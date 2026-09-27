import * as THREE from 'three/webgpu'
import {
  Break, Fn, If, Loop, atomicAdd, atomicMin, atomicStore, dot, exp, float, hash, instanceIndex, instancedArray, int,
  log, max, min, normalize, positionWorld, pow, reflect, refract, select, storage, struct, texture, uint, uniform,
  uniformArray, uv, vec2, vec3, vec4,
} from 'three/tsl'
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js'

// 宝石のコースティクス (宝石を通った光が床に落とす光の模様)
//
// gemTracer.ts の内部反射の計算を、カメラ側ではなくライト側から使う:
//   1. ライトから各宝石へ、光の向きに垂直な格子状に光線を撃つ (計算シェーダーで1本ずつ並列に処理)
//   2. 表面で屈折して中に入り、中で反射を繰り返す。面に当たるたびにフレネルの式で外に出る分を求める
//   3. 外に出た光が床(y=0)のどこに当たるかを求め、「光の粒」として記録する。
//      出口では光を波長ごと(赤→紫の6色)に分けて屈折させるので、粒が虹色の筋に並ぶ(分散・ファイア)
//   4. 光の粒を、床を真上から見た画像に1ピクセルの点として足し込んでいく。光が集まる所ほど明るくなる
//   5. 床のシェーダーがその画像を読んで、映り込みに足す
// 画像に貯まる値は「光の向きに垂直な面が受ける明るさ」を1とした床の明るさ。宝石が無ければ cos(入射角) になる。
// 模様は光線の追跡だけから決める。宝石の面は平らなので、同じ面の組み合わせを通った光は平行なまま床に届き、
// 明るさが一様で縁のくっきりした多角形になる (曲面が無いので、光が線状に集まる fold / cusp はできない)。
// その縁を物理以上に溶かさないよう、ぼけは「光源の大きさ」で物理的に付け (宝石から遠くへ飛んだ光ほど広がる)、
// 画像のガウスぼかしは粒のざらつきを消す最小限にとどめる。
// 床に届いた粒だけを記録し、その数をGPU上で数えてそのまま描く数にする(間接描画)ので、届かなかった光の分は描かない。
// 宝石も光の向きも変わらないフレーム(着地後など)は計算を省く。
// 他の宝石に遮られる光や、宝石の影は扱わない (床はライトで照らさない黒い鏡なので影は見えない)。

const RAYS_PER_SIDE = 96 // 宝石1個に撃つ光線の数 (縦×横)。多いほど模様のざらつきが減るが重い
const MAX_BOUNCES = 6 // コースティクスで追う最大反射回数 (Gem の bounces とこの小さい方)。それ以降の光は十分弱い
const WAVELENGTHS = 6 // 出口で光を分ける色の数
const AREA_HALF = 5 // コースティクスを描く床の範囲 (原点から ±AREA_HALF のワールド単位の正方形)
const RESOLUTION = 512 // その範囲を描く画像の解像度
const CAPACITY = 1 << 18 // 1回に記録できる光の粒の上限 (宝石8個で実際は数万粒)
const BLUR_TAPS = 6 // ぼかしのサンプル数 (中心の片側)

const RAYS_PER_GEM = RAYS_PER_SIDE * RAYS_PER_SIDE
const TEXEL = (AREA_HALF * 2) / RESOLUTION // 画像1ピクセルが覆う床の幅
// ぼかしの重み (±2.5σ を BLUR_TAPS 等分したガウス分布)。合計が1になるように割っておく
const BLUR_WEIGHTS = (() => {
  const weights = Array.from({ length: BLUR_TAPS + 1 }, (_, k) => Math.exp(-0.5 * ((k * 2.5) / BLUR_TAPS) ** 2))
  const total = weights[0] + 2 * weights.slice(1).reduce((a, b) => a + b, 0)
  return weights.map((w) => w / total)
})()

// 波長ごとの色 (赤→紫)。全部足すと白になるよう、赤・緑・青それぞれの合計を1に揃える
const SPECTRUM = (() => {
  const colors = Array.from({ length: WAVELENGTHS }, (_, k) => {
    const h = ((0.75 * k) / (WAVELENGTHS - 1)) * 6 // 色相 0(赤)〜0.75(紫)
    return new THREE.Vector3(Math.abs(h - 3) - 1, 2 - Math.abs(h - 2), 2 - Math.abs(h - 4)).clampScalar(0, 1)
  })
  const sum = colors.reduce((total, color) => total.add(color), new THREE.Vector3())
  return colors.map((color) => color.divide(sum))
})()

type GemSource = {
  gems: THREE.Mesh[] // 同じジオメトリを共有する宝石
  planes: THREE.Vector4[] // extractFacetPlanes() の結果
  material: THREE.MeshPhysicalNodeMaterial // ior などの値を読む
  bounces: { value: number } // Gem の bounces (uniform)
}

export function createCaustics(renderer: THREE.WebGPURenderer, light: THREE.DirectionalLight) {
  const target = new THREE.RenderTarget(RESOLUTION, RESOLUTION, { type: THREE.HalfFloatType, depthBuffer: false })
  // 床を真上から見下ろすカメラ (画面の上が -z)
  const topCamera = new THREE.OrthographicCamera(-AREA_HALF, AREA_HALF, AREA_HALF, -AREA_HALF, 0, 20)
  topCamera.position.set(0, 10, 0)
  topCamera.up.set(0, 0, -1)
  topCamera.lookAt(0, 0, 0)

  // --- 光の粒 ---
  const photonPosition = instancedArray(CAPACITY, 'vec2') // 床に当たった位置 (x, z)
  const photonColor = instancedArray(CAPACITY, 'vec4') // 運ぶ光 (rgb)
  // 記録した粒の数をGPU上で数え、そのまま描画する数にする (CPUへの読み戻しは要らない)
  const drawArgs = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 5)
  const drawStorage = storage(drawArgs, struct({
    vertexCount: 'uint',
    instanceCount: { type: 'uint', atomic: true },
    firstVertex: 'uint',
    firstInstance: 'uint',
    offset: 'uint',
  }, 'CausticDrawArgs'), 1)
  const photonCount = drawStorage.get('instanceCount')
  const resetNode = Fn(() => {
    drawStorage.get('vertexCount').assign(1)
    atomicStore(photonCount, uint(0))
  })().compute(1)
  // 上限を超えた粒は記録していないので、描く数も上限までにする
  const clampNode = Fn(() => {
    atomicMin(photonCount, uint(CAPACITY))
  })().compute(1)

  // 粒を1ピクセルの点として加算合成で描く
  const photonMaterial = new THREE.PointsNodeMaterial({
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const position = photonPosition.toAttribute()
  photonMaterial.positionNode = vec3(position.x, 0, position.y)
  photonMaterial.colorNode = vec4(photonColor.toAttribute().rgb, 1)
  const pointGeometry = new THREE.BufferGeometry()
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
  pointGeometry.setIndirect(drawArgs)
  const points = new THREE.Points(pointGeometry, photonMaterial)
  points.count = CAPACITY // 粒ごとのインスタンス描画にする (実際に描く数は drawArgs の値)
  points.frustumCulled = false
  const photonScene = new THREE.Scene()
  photonScene.add(points)

  // --- 床のシェーダーで使う: その場所に届いたコースティクスの光 ---
  const enabled = uniform(1) // 0 で床に足さない
  const strength = uniform(2) // 床がコースティクスを散らす強さ (拡散反射率)。黒い鏡なので本来はほぼ0だが、演出として強める
  // ライトの色・強さを掛ける (拡散面の明るさは 反射率 × 光の強さ / π。three.js の標準マテリアルと同じ基準)
  const lightColorValue = new THREE.Color()
  const lightColor = uniform(lightColorValue).onRenderUpdate(() => lightColorValue.copy(light.color).multiplyScalar(light.intensity / Math.PI))
  // --- ぼかし ---
  // 粒は1ピクセルずつ足しているので、そのままだと四角いドットに見える。画像を横→縦の順にガウスぼかしする
  // (target → blurTarget → target)。画像を作り直した時だけ実行するので、宝石が止まっている間は負荷がかからない
  const blur = uniform(0.06) // ぼかしの半径 (ガウス分布の標準偏差, ワールド単位。画像1ピクセルは約0.02)
  const blurTarget = target.clone()
  const createBlurPass = (source: THREE.Texture, direction: THREE.Vector2) => {
    // サンプルは中心の左右に BLUR_TAPS 個ずつ、±2.5σ の範囲に等間隔に並べる (重みは半径によらず一定)
    const step = max(blur.div(TEXEL), 0.01).mul(2.5 / BLUR_TAPS).div(RESOLUTION) // 画像のuvでの間隔
    const offset = vec2(direction.x, direction.y).mul(step)
    const material = new THREE.NodeMaterial()
    material.fragmentNode = Fn(() => {
      const sum = vec3(0).toVar()
      for (let k = -BLUR_TAPS; k <= BLUR_TAPS; k++) {
        sum.addAssign(texture(source, uv().add(offset.mul(k))).rgb.mul(BLUR_WEIGHTS[Math.abs(k)]))
      }
      return vec4(sum, 1)
    })()
    return new THREE.QuadMesh(material)
  }
  const blurHorizontal = createBlurPass(target.texture, new THREE.Vector2(1, 0))
  const blurVertical = createBlurPass(blurTarget.texture, new THREE.Vector2(0, 1))

  const floorUV = positionWorld.xz.div(AREA_HALF * 2).add(0.5)
  const inside = select(floorUV.x.greaterThan(0).and(floorUV.x.lessThan(1)).and(floorUV.y.greaterThan(0)).and(floorUV.y.lessThan(1)), float(1), float(0))
  const floorLight = texture(target.texture, floorUV).rgb.mul(lightColor).mul(strength).mul(enabled).mul(inside)

  // WebGL2 にフォールバックした環境では計算シェーダーの書き込みや間接描画が使えないので、何もしない
  const supported = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
  let source: GemSource | undefined
  let traceNode: THREE.ComputeNode | undefined
  let syncUniforms = () => {}
  let lastSignature = ''
  const params = { enabled: true, azimuth: 0, elevation: 0, lightSize: 1.5 }
  const lightSpread = uniform(Math.tan(THREE.MathUtils.degToRad(params.lightSize))) // tan(光源の見かけの半径)

  // 宝石が読み込まれてから光線追跡の計算シェーダーを組み立てる
  function setGems(gemSource: GemSource, gui: GUI) {
    source = gemSource
    const { gems, planes, material, bounces } = gemSource
    const rayCount = gems.length * RAYS_PER_GEM

    const geometry = gems[0].geometry
    if (!geometry.boundingSphere) geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere!

    // 宝石ごとの値はCPU側で毎フレーム詰め直す
    const worldMatrices = gems.map(() => new THREE.Matrix4())
    const inverseMatrices = gems.map(() => new THREE.Matrix4())
    const gemColors = gems.map(() => new THREE.Color())
    const worldArray = uniformArray(worldMatrices, 'mat4' as const)
    const inverseArray = uniformArray(inverseMatrices, 'mat4' as const)
    const colorArray = uniformArray(gemColors, 'color' as const)
    const fireScales = gems.map(() => 1) // 分散の倍率 (宝石ごと。gemTracer.ts と同じ)
    const fireArray = uniformArray(fireScales, 'float' as const)
    const planeArray = uniformArray(planes, 'vec4' as const)
    const planeCount = planes.length

    const lightDir = uniform(new THREE.Vector3()) // 光の進む向き
    const lightU = uniform(new THREE.Vector3()) // 光の向きに垂直な2軸 (光線の格子を張る)
    const lightV = uniform(new THREE.Vector3())
    const ior = uniform(material.ior)
    const dispersion = uniform(material.dispersion)
    const attenuationDistance = uniform(material.attenuationDistance)
    const baseColor = uniform(new THREE.Color())
    const bounceCount = uniform(MAX_BOUNCES, 'int')

    const lightPosition = new THREE.Vector3()
    const up = new THREE.Vector3()
    syncUniforms = () => {
      gems.forEach((gem, i) => {
        gem.updateWorldMatrix(true, false)
        worldMatrices[i].copy(gem.matrixWorld)
        inverseMatrices[i].copy(gem.matrixWorld).invert()
        gemColors[i].copy(gem.userData.gemColor)
        fireScales[i] = gem.userData.fireScale ?? 1
      })
      light.updateWorldMatrix(true, false)
      light.target.updateWorldMatrix(true, false)
      const dir = lightDir.value.setFromMatrixPosition(light.target.matrixWorld)
        .sub(lightPosition.setFromMatrixPosition(light.matrixWorld)).normalize()
      up.set(0, 1, 0)
      if (Math.abs(dir.y) > 0.99) up.set(1, 0, 0)
      lightU.value.crossVectors(dir, up).normalize()
      lightV.value.crossVectors(dir, lightU.value)
      ior.value = material.ior
      dispersion.value = material.dispersion
      attenuationDistance.value = material.attenuationDistance
      baseColor.value.copy(material.color)
      bounceCount.value = Math.min(bounces.value, MAX_BOUNCES)
    }

    // 中から外への屈折 (gemTracer.ts と同じ)。全反射で出られない時は canExit=0
    const exitRay = (dir: THREE.Node<'vec3'>, normal: THREE.Node<'vec3'>, eta: THREE.Node<'float'>) => {
      const refracted = refract(dir, normal.negate(), eta)
      const canExit = select(dot(refracted, refracted).greaterThan(1e-6), float(1), float(0))
      return { dir: select(canExit.greaterThan(0), refracted, normal), canExit }
    }

    // 光の粒を1つ記録する。書き込む場所は、記録済みの数を1増やして決める
    const emit = (hit: THREE.Node<'vec2'>, color: THREE.Node<'vec3'>) => {
      // 増やす前の値が返る (as: @types/three 0.185 では atomicAdd の戻り値の型が unknown のため)
      const slot = atomicAdd(photonCount, uint(1)) as unknown as THREE.Node<'uint'>
      If(slot.lessThan(uint(CAPACITY)), () => {
        photonPosition.element(slot).assign(hit)
        photonColor.element(slot).assign(vec4(color, 1))
      })
    }

    traceNode = Fn(() => {
      const gemIndex = instanceIndex.div(RAYS_PER_GEM)
      const cell = instanceIndex.mod(RAYS_PER_GEM)

      const world = worldArray.element(gemIndex)
      const inverse = inverseArray.element(gemIndex)
      const modelScale = world.mul(vec4(1, 0, 0, 0)).xyz.length().toVar()
      const center = world.mul(vec4(vec3(...sphere.center.toArray()), 1)).xyz
      const radius = modelScale.mul(sphere.radius).toVar()

      // 光線の格子。規則正しすぎると模様に縞が出るので、光線ごとに固定の揺らぎを入れる
      const gx = float(cell.mod(RAYS_PER_SIDE)).add(hash(instanceIndex)).div(RAYS_PER_SIDE).mul(2).sub(1)
      const gy = float(cell.div(RAYS_PER_SIDE)).add(hash(instanceIndex.add(rayCount))).div(RAYS_PER_SIDE).mul(2).sub(1)
      const originWorld = center.add(lightU.mul(gx.mul(radius))).add(lightV.mul(gy.mul(radius))).sub(lightDir.mul(radius.mul(2)))
      // 光線1本が運ぶ光の量 = 格子1マスの面積 ÷ 画像1ピクセルが覆う床の面積
      const cellArea = radius.mul(2 / RAYS_PER_SIDE).pow(2)
      const photonWeight = cellArea.div(TEXEL ** 2).toVar()

      // 計算は宝石のローカル座標で行う (面の平面を変換し直さなくて済む)。
      // toVar() で一度だけ計算する (付けないと、使う場所ごと = 下のループの中で毎回計算し直される)
      const origin = inverse.mul(vec4(originWorld, 1)).xyz.toVar()
      // 光源の大きさ: 光線ごとに、光源の円盤の中の少しずれた方向から来るようにする
      const angle = hash(instanceIndex.add(rayCount * 2)).mul(Math.PI * 2)
      const offAxis = hash(instanceIndex.add(rayCount * 3)).sqrt().mul(lightSpread) // 円盤内で一様になるよう sqrt
      const incoming = lightDir.add(lightU.mul(angle.cos().mul(offAxis))).add(lightV.mul(angle.sin().mul(offAxis)))
      const rayDir = normalize(inverse.mul(vec4(incoming, 0)).xyz).toVar()

      // 外から凸多面体に入る点: 光に向いた面の平面との交点のうち最も遠いもの。
      // それが光と同じ向きの面の平面との交点のうち最も近いものより手前なら、宝石に当たっている
      const tEnter = float(-1e6).toVar()
      const tLeave = float(1e6).toVar()
      const entryNormal = vec3(0, 1, 0).toVar()
      Loop(planeCount, ({ i }) => {
        const plane = planeArray.element(i)
        const facing = dot(plane.xyz, rayDir)
        const t = plane.w.sub(dot(plane.xyz, origin)).div(facing)
        If(facing.lessThan(-1e-6), () => {
          If(t.greaterThan(tEnter), () => {
            tEnter.assign(t)
            entryNormal.assign(plane.xyz)
          })
        }).ElseIf(facing.greaterThan(1e-6), () => {
          tLeave.assign(min(tLeave, t))
        })
      })

      If(tEnter.lessThan(tLeave), () => {
        // 分散: 波長ごとに屈折率を ior-spread (赤) 〜 ior+spread (紫) で変える (gemTracer.ts と同じ幅)
        const spread = ior.sub(1).mul(dispersion.mul(fireArray.element(gemIndex)).mul(0.025)).toVar()
        const f0 = pow(ior.sub(1).div(ior.add(1)), 2).toVar()
        const schlick = (cosine: THREE.Node<'float'>) => f0.add(float(1).sub(f0).mul(pow(float(1).sub(cosine), 5)))
        const absorption = log(max(colorArray.element(gemIndex), vec3(1e-4))).negate().div(attenuationDistance).toVar()

        const pos = origin.add(rayDir.mul(tEnter)).toVar()
        const dir = refract(rayDir, entryNormal, float(1).div(ior)).toVar()
        // 表面で反射せずに中へ入った割合から始める
        const throughput = vec3(float(1).sub(schlick(dot(rayDir.negate(), entryNormal)))).mul(baseColor).toVar()

        Loop({ start: int(0), end: bounceCount, type: 'int' }, () => {
          // 進行方向を向いた面のうち、最も近い平面との交点が出口
          const tMin = float(1e6).toVar()
          const hitNormal = vec3(0, 1, 0).toVar()
          Loop(planeCount, ({ i }) => {
            const plane = planeArray.element(i)
            const facing = dot(plane.xyz, dir)
            If(facing.greaterThan(1e-6), () => {
              const t = plane.w.sub(dot(plane.xyz, pos)).div(facing)
              If(t.lessThan(tMin), () => {
                tMin.assign(t)
                hitNormal.assign(plane.xyz)
              })
            })
          })
          const segment = max(tMin, 0)
          pos.addAssign(dir.mul(segment))
          throughput.mulAssign(exp(absorption.negate().mul(segment.mul(modelScale))))

          // 波長ごとに外へ屈折させ、床に届いた光を粒として記録する
          const exitPos = world.mul(vec4(pos, 1)).xyz.toVar()
          const reflectances = SPECTRUM.map((tint, k) => {
            const eta = ior.add(spread.mul((2 * k) / (WAVELENGTHS - 1) - 1))
            const exit = exitRay(dir, hitNormal, eta)
            const reflectance = select(exit.canExit.greaterThan(0), schlick(dot(exit.dir, hitNormal)), float(1)).toVar()
            const exitDir = normalize(world.mul(vec4(exit.dir, 0)).xyz)
            If(exit.canExit.greaterThan(0).and(exitDir.y.lessThan(-1e-4)).and(exitPos.y.greaterThan(0)), () => {
              const hit = exitPos.xz.add(exitDir.xz.mul(exitPos.y.div(exitDir.y.negate())))
              emit(hit, throughput.mul(vec3(tint.x, tint.y, tint.z)).mul(float(1).sub(reflectance)).mul(photonWeight))
            })
            return reflectance
          })

          // 中に残る光: 波長ごとの反射率を、その波長の色の重みで赤・緑・青に戻して掛ける
          const remaining = reflectances.reduce<THREE.Node<'vec3'>>(
            (sum, reflectance, k) => sum.add(vec3(SPECTRUM[k].x, SPECTRUM[k].y, SPECTRUM[k].z).mul(reflectance)), vec3(0))
          throughput.mulAssign(remaining)
          dir.assign(reflect(dir, hitNormal))
          If(max(throughput.x, max(throughput.y, throughput.z)).lessThan(0.005), () => {
            Break()
          })
        })
      })
    })().compute(rayCount)

    // --- GUI ---
    // ライトの向きは既存の平行光源を動かす (宝石の表面のハイライトも同じライトなので一緒に変わる)
    const offset = light.position.clone().sub(light.target.position)
    const spherical = new THREE.Spherical().setFromVector3(offset)
    params.azimuth = THREE.MathUtils.radToDeg(spherical.theta)
    params.elevation = 90 - THREE.MathUtils.radToDeg(spherical.phi)
    const moveLight = () => {
      spherical.theta = THREE.MathUtils.degToRad(params.azimuth)
      spherical.phi = THREE.MathUtils.degToRad(90 - params.elevation)
      light.position.setFromSpherical(spherical).add(light.target.position)
    }
    // オン・オフは HUD (hud.ts) から setEnabled で切り替える
    const folder = gui.addFolder('Caustics')
    folder.add(strength, 'value', 0, 10).name('strength')
    folder.add(blur, 'value', 0, 0.2).name('blur')
    folder.add(params, 'azimuth', -180, 180).name('light azimuth').onChange(moveLight)
    folder.add(params, 'elevation', 5, 90).name('light elevation').onChange(moveLight)
    // 光源の見かけの大きさ (半径, 度)。太陽は約0.27°。大きいほど、宝石から遠い所の模様が柔らかくなる
    folder.add(params, 'lightSize', 0, 10).name('light size').onChange((deg: number) => (lightSpread.value = Math.tan(THREE.MathUtils.degToRad(deg))))
    folder.add(light, 'intensity', 0, 10).name('light intensity')
  }

  // 毎フレーム、描画の前に呼ぶ
  function update() {
    if (!supported || !source || !traceNode || !params.enabled) return
    syncUniforms()
    // 宝石・ライト・マテリアルの値が前のフレームと同じなら、前の結果をそのまま使う
    const { gems, material, bounces } = source
    const signature = [
      ...gems.flatMap((gem) => [...gem.matrixWorld.elements, gem.userData.gemColor.getHex(), gem.userData.fireScale]),
      light.position.x, light.position.y, light.position.z, lightSpread.value,
      material.ior, material.dispersion, material.attenuationDistance, material.color.getHex(), bounces.value, blur.value,
    ].join(',')
    if (signature === lastSignature) return
    lastSignature = signature

    renderer.compute([resetNode, traceNode, clampNode])
    const previousTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    renderer.render(photonScene, topCamera)
    renderer.setRenderTarget(blurTarget)
    blurHorizontal.render(renderer)
    renderer.setRenderTarget(target)
    blurVertical.render(renderer)
    renderer.setRenderTarget(previousTarget)
  }

  // 床に足すかどうか。切っている間は光線追跡の計算もしない (再び入れた時、宝石が動いていれば計算し直す)
  function setEnabled(value: boolean) {
    params.enabled = value
    enabled.value = value ? 1 : 0
  }

  // lightSize: 光源の見かけの半径(度)。studio.ts のキーライトも同じ大きさにする
  return { floorLight, setGems, update, lightSize: () => params.lightSize, supported, isEnabled: () => params.enabled, setEnabled }
}
