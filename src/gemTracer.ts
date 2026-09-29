import * as THREE from 'three/webgpu'
import {
  Break, Fn, If, Loop, cameraPosition, dot, exp, float, int, log, materialAttenuationDistance, materialColor,
  materialDispersion, materialIOR, materialRoughness, max, modelWorldMatrix, modelWorldMatrixInverse, normalLocal,
  normalize, pmremTexture, positionLocal, pow, reflect, refract, select, uniformArray, vec3, vec4,
} from 'three/tsl'

// 宝石の内部反射シェーダー
//
// three.js 標準の透過(transmission)は「1回屈折させて画面の背景を覗く」だけで、宝石の中で光が
// 何度も反射する様子(ブリリアンスやファイアの元)は再現されない。ここでは宝石の中の光線を実際に追跡する:
//   1. カメラからの光線を表面で屈折させて中に入れる
//   2. 中を進んで、どの面から出ていくかを求める
//   3. 当たった面でフレネルの式に従い「外に出る光」と「中で反射して残る光」に分ける (全反射なら全部残る)
//   4. 外に出た光はその方向の環境マップの色を拾う。残った光は反射してまた 2 へ
// 光が中を進んだ実際の距離で吸収(ランベルト・ベール則)を掛けるので、光路が長いほど色が濃くなる。
// 分散(ファイア)は、光の通り道は1本だけ追跡し、面から外へ出る瞬間だけ赤・緑・青で屈折の向きを変えて
// 近似する (経路を色ごとに3回追跡するより約3倍軽い。ファイアは主に出口の屈折の差で生まれる)。
//
// 光線と面の交差は、宝石が凸多面体であることを使って「面の平面」だけで求める。凸多面体の内側から
// 出ていく点は、進行方向を向いた面の平面との交点のうち最も近いもの。三角形ごとに調べるより軽い。
// そのため凹みのある形状には使えない。
//
// 重さのほとんどはこの「全部の面を調べる」ところ (1ピクセルあたり 反射5回 × 193面)。iPhone・iPad では1コマの大半を占めた。
// そこで面を向きで3つのまとまりに分け (groupFacetPlanes)、出口になりえないと確かめられるまとまりは丸ごと飛ばす。
// 飛ばすのは確かめられた時だけなので、結果は全部調べた時と同じ:
// - 上向きの面 (テーブル・クラウン): 光が急な下向きに進む時は、どれも進行方向を向かない (一番寝た面の傾きで決まる)
// - 下向きの面 (パビリオン): 同じく、急な上向きの時は飛ばす
// - 横向きの面 (ガードル): 先に上下の面で出口を求め、その点がガードルの内側にあれば、ガードルからは出ない
// iPhone 16 Pro (?bench、宝石が画面いっぱいの場面) で、宝石の描画は 18.1ms → 8.2ms、全体で 33 → 52fps になった。
// Mac (M1 Max・Chrome) では速さは変わらなかった (GPU とシェーダーの組み立て方の違い)。
// 試して採らなかったもの: 環境マップを PMREM の代わりに普通のキューブマップで引く。単独では Mac で変わらず、
// この方式と組み合わせると Mac で2倍遅くなった (シェーダーが同時に抱える値が増え、GPU が同時に動かせる数が減ったと思われる)

// ジオメトリから面の平面(外向き法線 xyz と、原点からの距離 w)を重複なしで取り出す
export function extractFacetPlanes(geometry: THREE.BufferGeometry): THREE.Vector4[] {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : position.count
  const triangle = new THREE.Triangle()
  const normal = new THREE.Vector3()
  const planes: THREE.Vector4[] = []
  for (let i = 0; i < count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => index ? index.getX(i + k) : i + k)
    triangle.a.fromBufferAttribute(position, a)
    triangle.b.fromBufferAttribute(position, b)
    triangle.c.fromBufferAttribute(position, c)
    if (triangle.getArea() < 1e-8) continue
    triangle.getNormal(normal)
    const d = normal.dot(triangle.a)
    const duplicate = planes.some((p) => p.x * normal.x + p.y * normal.y + p.z * normal.z > 0.9999 && Math.abs(p.w - d) < 1e-4)
    if (!duplicate) planes.push(new THREE.Vector4(normal.x, normal.y, normal.z, d))
  }
  return planes
}

// 面を法線の向きで 上向き・下向き・横向き に分けて並べ直し、まとまりごと飛ばす判定に使う値を求める
const SIDE_Y = 0.2 // 法線の y の絶対値がこれ以下の面を横向き (ガードル) とする
function groupFacetPlanes(planes: THREE.Vector4[]) {
  const up = planes.filter((p) => p.y > SIDE_Y)
  const down = planes.filter((p) => p.y < -SIDE_Y)
  const side = planes.filter((p) => Math.abs(p.y) <= SIDE_Y)
  const horizontal = (p: THREE.Vector4) => Math.hypot(p.x, p.z)
  // まとまりの中で一番寝た面の傾き (|法線の y| ÷ 法線の水平成分)。光の向きの水平成分が「縦成分 × これ」以下なら、
  // どの面も進行方向を向かない (真上・真下向きの面だけなら大きな値にしておく)
  const slope = (group: THREE.Vector4[]) => Math.min(1e6, ...group.map((p) => Math.abs(p.y) / Math.max(horizontal(p), 1e-9)))
  // 点 (水平の距離 r, 高さ y) が横向きの面すべての内側にあると言える条件: r × sideXZ + |y| × sideY ≤ sideW
  const sideXZ = Math.max(0, ...side.map(horizontal))
  const sideY = Math.max(0, ...side.map((p) => Math.abs(p.y)))
  const sideW = Math.min(1e6, ...side.map((p) => p.w))
  return {
    planes: [...up, ...down, ...side], // この順に並べる
    upCount: up.length,
    downCount: down.length,
    upSlope: slope(up),
    downSlope: slope(down),
    sideXZ,
    sideY,
    sideW,
  }
}

type GemTracerOptions = {
  planes: THREE.Vector4[]
  envMap: THREE.Texture
  envIntensity: THREE.Node<'float'> // scene.environmentIntensity を反映させる
  gemColor: THREE.Node<'color'> // 吸収色 (宝石ごとの色)
  bounces: THREE.Node<'int'> // 中で反射させる最大回数
  fireScale: THREE.Node<'float'> // 分散(ファイア)の倍率 (宝石ごと。色石はダイヤより弱い)
}

// 宝石の中を通って出てくる光(表面反射を除いた分)を返す。マテリアルの ior/dispersion/roughness/
// attenuationDistance/color(基本色) を参照するので、GUIの値がそのまま効く
export function createGemTracer({ planes, envMap, envIntensity, gemColor, bounces, fireScale }: GemTracerOptions) {
  const groups = groupFacetPlanes(planes)
  const planeArray = uniformArray(groups.planes, 'vec4' as const)
  const sideStart = groups.upCount + groups.downCount

  // 環境マップはワールド座標の方向で引く。roughness が大きいほどぼけた映り込みになる
  const sampleEnvironment = (dirLocal: THREE.Node<'vec3'>) => {
    const dirWorld = normalize(modelWorldMatrix.mul(vec4(dirLocal, 0)).xyz)
    return pmremTexture(envMap, dirWorld, materialRoughness).rgb.mul(envIntensity)
  }

  // 中から外への屈折の向き。全反射で出られない時は代わりの向きを返し(0ベクトルだと正規化で壊れるため)、
  // canExit=0 にする
  const exitRay = (dir: THREE.Node<'vec3'>, normal: THREE.Node<'vec3'>, ior: THREE.Node<'float'>) => {
    const refracted = refract(dir, normal.negate(), ior)
    const canExit = select(dot(refracted, refracted).greaterThan(1e-6), float(1), float(0))
    return { dir: select(canExit.greaterThan(0), refracted, normal), canExit }
  }

  return Fn(() => {
    // 計算はモデルのローカル座標で行う (アニメーションで動いても面の平面を変換し直さなくて済む)
    const cameraLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz
    const viewDir = normalize(positionLocal.sub(cameraLocal))
    const surfaceNormal = normalize(normalLocal)
    const modelScale = modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz.length() // 吸収の距離をワールドの長さに直す
    // 吸収係数。透過率 = exp(-係数 × 距離) で、attenuationDistance 進むと gemColor になる
    const absorption = log(max(gemColor, vec3(1e-4))).negate().div(materialAttenuationDistance)

    const ior = materialIOR
    // 分散: 赤は屈折率を小さく、青は大きくする (three.js 標準の transmission と同じ式)
    const dispersion = materialDispersion.mul(fireScale)
    const spread = ior.sub(1).mul(dispersion.mul(0.025))
    const useDispersion = dispersion.greaterThan(0)
    const f0 = pow(ior.sub(1).div(ior.add(1)), 2) // 垂直入射での反射率
    // 外に出る時の反射率 (Schlick近似)。全反射なら1
    const exitFresnel = (exit: { dir: THREE.Node<'vec3'>; canExit: THREE.Node<'float'> }, normal: THREE.Node<'vec3'>) =>
      select(exit.canExit.greaterThan(0), f0.add(float(1).sub(f0).mul(pow(float(1).sub(dot(exit.dir, normal)), 5))), float(1))

    const dir = refract(viewDir, surfaceNormal, float(1).div(ior)).toVar()
    const pos = positionLocal.toVar()
    const throughput = vec3(1).toVar() // まだ中に残っている光の割合 (色ごと)
    const radiance = vec3(0).toVar()

    Loop({ start: int(0), end: bounces, type: 'int' }, () => {
      // 進行方向を向いた面のうち、最も近い平面との交点が出口
      const tMin = float(1e6).toVar()
      const hitNormal = vec3(0, 1, 0).toVar()
      const testPlanes = (start: number, end: number) => {
        if (end <= start) return
        Loop({ start: int(start), end: int(end), type: 'int' }, ({ i }) => {
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
      }
      // 上向き・下向きの面は、光が急な下向き・上向きに進む時は飛ばす
      const across = dir.xz.length().toVar()
      If(across.greaterThan(dir.y.negate().mul(groups.upSlope)), () => testPlanes(0, groups.upCount))
      If(across.greaterThan(dir.y.mul(groups.downSlope)), () => testPlanes(groups.upCount, sideStart))
      // 横向きの面は、上下の面で求めた出口がガードルの内側に無い時だけ調べる
      const exit = pos.add(dir.mul(tMin))
      If(exit.xz.length().mul(groups.sideXZ).add(exit.y.abs().mul(groups.sideY)).greaterThan(groups.sideW), () =>
        testPlanes(sideStart, groups.planes.length),
      )

      const segment = max(tMin, 0)
      pos.addAssign(dir.mul(segment))
      throughput.mulAssign(exp(absorption.negate().mul(segment.mul(modelScale))))

      // 面で外に出る光と中に残る光を色ごとに分ける
      const exitG = exitRay(dir, hitNormal, ior)
      const fresnel = vec3(exitFresnel(exitG, hitNormal)).toVar()
      const exitLight = sampleEnvironment(exitG.dir).toVar()
      If(useDispersion, () => {
        const exitR = exitRay(dir, hitNormal, ior.sub(spread))
        const exitB = exitRay(dir, hitNormal, ior.add(spread))
        fresnel.assign(vec3(exitFresnel(exitR, hitNormal), fresnel.y, exitFresnel(exitB, hitNormal)))
        exitLight.assign(vec3(sampleEnvironment(exitR.dir).x, exitLight.y, sampleEnvironment(exitB.dir).z))
      })
      radiance.addAssign(throughput.mul(vec3(1).sub(fresnel)).mul(exitLight))
      throughput.mulAssign(fresnel)
      dir.assign(reflect(dir, hitNormal))

      // 残りがほとんど無くなったら打ち切る
      If(max(throughput.x, max(throughput.y, throughput.z)).lessThan(0.005), () => {
        Break()
      })
    })

    // 最大回数まで反射しても残っている光は、最後の方向の環境で近似する
    radiance.addAssign(throughput.mul(sampleEnvironment(dir)))

    // 表面で反射せずに中へ入った割合を掛ける (表面反射そのものはマテリアルの鏡面反射が描く)
    const entry = float(1).sub(f0.add(float(1).sub(f0).mul(pow(float(1).sub(dot(viewDir.negate(), surfaceNormal)), 5))))
    return radiance.mul(entry).mul(materialColor)
  })()
}
