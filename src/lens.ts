import * as THREE from 'three/webgpu'
import { Fn, float, luminance, max, min, mix, rand, screenSize, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl'
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js'

// レンズとフィルムの仕上げ (ルック改善の3段目)。「1台のカメラで撮った」ように、光学的な癖を控えめに足す。
// どれも最後の1回の描画の中で、既にある画像 (DoF の後の画像) を数点読むだけで計算し、描画の回数は増やさない。
// - ボケの形: DoF のボケを絞り羽根の形 (正多角形) にする。八角形で HUD の宝石ボタンと呼応させる
// - シャープ: ピントの合った面の輪郭を締める。周りの最大・最小を超えないように抑えるので、縁に白黒の縁取りが出ない (RCAS と同じ考え方)
// - 色収差: 画面の端ほど赤と青がずれる。中心からの距離の3乗でずらすので、中央の宝石はずれない
// - 周辺減光: 画面の端ほど暗くする (レンズの端を通る光が減る)
// 以上はトーンマッピングの前 (光の量のまま) に掛け、フィルムの粒子だけトーンマッピングの後に足す
// - フィルムの粒子: 平均0の細かいノイズ。暗い所ほど強い。背景のなだらかなグラデーションの縞 (バンディング) を消す効果もある。
//   描いたフレームごとに変わり、止まって描画を省いている間は止まる

type Kernels = { points16: THREE.Vector2[]; points64: THREE.Vector2[] }

export function createLens(gui: GUI) {
  const params = { blades: 8 }
  const sharpen = uniform(0.35) // 0で無効
  const aberration = uniform(0.006) // 画面の角でのずれ (画面の高さに対する割合)。0で無効
  const vignette = uniform(0.35) // 画面の角での暗さ。0で無効
  const grain = uniform(0.03) // 粒子の強さ (表示の明るさ 0〜1 に対して)。0で無効
  const seed = uniform(0)

  // --- ボケの形 ---
  // DepthOfFieldNode は円盤の中に並べた点 (_generateKernels) を集めてぼかすので、その点を正多角形の内側に寄せ直す。
  // 点の配列は描画のたびにシェーダーへ送り直されるので、羽根の枚数は後から変えられる
  let kernels: Kernels | undefined
  let disc: THREE.Vector2[] = [] // 元の円盤の点
  const applyBlades = () => {
    if (!kernels) return
    const n = params.blades
    const points = [...kernels.points16, ...kernels.points64]
    points.forEach((point, i) => {
      const { x, y } = disc[i]
      let scale = 1
      if (n >= 3) {
        // 多角形の縁までの距離 (外接円の半径 = 1)。辺の中点が真上に来る (平らな辺が上) ように回す
        const sector = (2 * Math.PI) / n
        const angle = Math.atan2(y, x) - Math.PI / 2 + sector / 2
        const offset = angle - Math.floor(angle / sector) * sector - sector / 2
        scale = Math.cos(Math.PI / n) / Math.cos(offset)
      }
      point.set(x * scale, y * scale)
    })
  }
  function shapeBokeh(dofNode: unknown) {
    const node = dofNode as { _generateKernels(): Kernels }
    const generate = node._generateKernels.bind(node)
    node._generateKernels = () => {
      kernels = generate()
      disc = [...kernels.points16, ...kernels.points64].map((point) => point.clone())
      applyBlades()
      return kernels
    }
  }

  // --- トーンマッピングの前 ---
  // base: 今の画素の色 (DoF の後の画像)。source: 同じ画像のテクスチャ (周りと、ずらした位置を読むのに使う)
  const optics = (base: THREE.Node<'vec4'>, source: THREE.TextureNode) =>
    Fn(() => {
      const texel = vec2(1).div(screenSize)
      const center = base.rgb

      // シャープ: 上下左右との差を強調し、周りの最大・最小の範囲に収める
      const n = source.sample(screenUV.add(vec2(0, texel.y))).rgb
      const s = source.sample(screenUV.sub(vec2(0, texel.y))).rgb
      const e = source.sample(screenUV.add(vec2(texel.x, 0))).rgb
      const w = source.sample(screenUV.sub(vec2(texel.x, 0))).rgb
      const sharpened = center.add(center.mul(4).sub(n.add(s).add(e).add(w)).mul(sharpen.mul(0.25)))
      const low = min(min(min(n, s), min(e, w)), center)
      const high = max(max(max(n, s), max(e, w)), center)
      const detail = sharpened.clamp(low, high).sub(center)

      // 色収差: 中心からの距離の3乗で、赤は内側・青は外側から読む
      const aspect = screenSize.x.div(screenSize.y)
      const fromCenter = screenUV.sub(0.5)
      const radius = fromCenter.mul(vec2(aspect, 1)).length()
      const shift = fromCenter.mul(aberration.mul(radius.mul(radius)))
      const red = source.sample(screenUV.sub(shift)).r
      const blue = source.sample(screenUV.add(shift)).b
      const color = vec3(red, center.g, blue).add(detail)
      return vec4(color, 1)
    })()

  // 周辺減光 (ブルーム・光条を足した後の全体に掛ける)
  const darkenEdges = (color: THREE.Node<'vec4'>) =>
    Fn(() => {
      const aspect = screenSize.x.div(screenSize.y)
      const radius = screenUV.sub(0.5).mul(vec2(aspect, 1)).length()
      const falloff = smoothstep(0.35, 1.1, radius)
      return vec4(color.rgb.mul(float(1).sub(vignette.mul(falloff))), color.a)
    })()

  // --- トーンマッピングの後 ---
  const addGrain = (color: THREE.Node<'vec4'>) =>
    Fn(() => {
      const noise = rand(screenUV.mul(vec2(1.37, 1.91)).add(seed)).sub(0.5)
      const strength = grain.mul(mix(float(1), float(0.35), luminance(color.rgb).clamp(0, 1))) // 明るい所ほど弱く
      return vec4(color.rgb.add(noise.mul(strength)), color.a)
    })()

  // 描くフレームごとに呼ぶ (粒子の模様を変える)
  function update() {
    seed.value = (seed.value + 0.6180339) % 1
  }

  const folder = gui.addFolder('Lens')
  folder.add(params, 'blades', { circle: 0, hexagon: 6, octagon: 8 }).name('bokeh').onChange(applyBlades)
  folder.add(sharpen, 'value', 0, 1).name('sharpen')
  folder.add(aberration, 'value', 0, 0.03).name('aberration')
  folder.add(vignette, 'value', 0, 1).name('vignette')
  folder.add(grain, 'value', 0, 0.1).name('grain')

  return { shapeBokeh, optics, darkenEdges, addGrain, update }
}
