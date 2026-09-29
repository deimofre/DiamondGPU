import * as THREE from 'three/webgpu'
import { quality } from './quality'
import { median, type FrameTiming } from './frameTiming'

// 描画倍率 (画面の1ピクセルを何ピクセル分で描くか) を決める。動いている間と止まっている間で分ける
// - 動いている間 (落下中・ドラッグ中): 描く画素の数が quality.motionPixels に収まる倍率で、滑らかさを優先する。
//   重さのほとんどを占める宝石の描画 (内部反射) は、描く画素の数にほぼ比例して重くなる。
//   スマホ・タブレットは50万画素 (iPhone 16 Pro 約1.3倍、11インチ iPad の横向き 約0.77倍)、PC は300万画素 (Retina で約1.44倍)
// - 止まっている間: 動きが止まったら、上限の倍率 (スマホ1.5倍、PC は画面本来の倍率) で1回だけ描き直す (main.ts)。
//   止まっている間は描き直さないので、重い1枚は一度だけ。拡大してじっくり見る時に細かさが出る
// - 動いている間の GPU の時間 (中央値) が quality.slowGpu を超える状態が1秒続いたら、動いている間の倍率を1段下げる。
//   見積もりより GPU が弱い端末 (古い iPhone、家庭用の PC など) 向け。上げ直しはしない (行き来すると、そのたびに一瞬引っかかり、
//   くっきりさも変わって見えるため)。判定は描く速さでなく GPU の時間で行う (低電力モードでは Safari が描く回数を
//   1秒30回に抑えるので、描く速さで判定すると、GPU に余裕があっても下げてしまう)
const SLOW_GAP = 40 // GPU の時間が取れない WebGL2 では、コマの間隔の中央値がこれ (ms) を超えたら (低電力モードの30fpsでは下げない)
const WINDOW = 1000 // 判定に使う長さ (ms)
const MIN_FRAMES = 10 // その間にこれだけ描いていたら判定する (止まって眺めている間は描かないので判定しない)
const STEP = 0.85 // 1段で倍率に掛ける値 (描く画素の数は約7割になる)
const COOLDOWN = 1500 // 倍率を変えた後、判定を休む時間 (ms。描画用の画像を作り直した直後のコマは遅いため)
const MIN_RATIO = 0.5

export function createResolution(renderer: THREE.WebGPURenderer, { auto, onChange }: { auto: boolean; onChange(): void }) {
  let scale = 1 // 自動で下げた分
  let steps = 0
  let manual: number | undefined // GUI で決めた倍率 (決めた後は自動で変えない)
  let still = false // 止まっている間の倍率で描いているか
  let resting = 0 // この時刻までは判定しない

  // 止まっている間の倍率 (上限)
  const stillRatio = () => Math.min(devicePixelRatio, quality.maxPixelRatio)
  // 動いている間の倍率: 描く画素の数を予算に収め、自動で下げた分を掛ける
  const fitted = () => Math.min(stillRatio(), Math.sqrt(quality.motionPixels / (innerWidth * innerHeight)))
  const motionRatio = () => Math.max(MIN_RATIO, fitted() * scale)

  // notify: onChange を呼ぶか (最初の1回は、呼び出し側の準備がまだなので呼ばない)
  function apply(notify = true) {
    const ratio = manual ?? (still ? stillRatio() : motionRatio())
    if (ratio === renderer.getPixelRatio()) return
    renderer.setPixelRatio(ratio)
    resting = performance.now() + COOLDOWN
    if (notify) onChange()
  }
  apply(false)

  // 毎コマ呼ぶ (描かなかったコマも)。動いている間の GPU の時間を見て、重すぎる状態が続いたら動いている間の倍率を下げる
  function update(timing: FrameTiming) {
    const now = performance.now()
    if (!auto || still || manual !== undefined || now < resting) return
    if (fitted() * scale * STEP < MIN_RATIO) return
    const frames = timing.between(Math.max(now - WINDOW, resting))
    if (frames.length < MIN_FRAMES) return
    const gpu = frames.flatMap((frame) => (frame.gpu === undefined ? [] : [frame.gpu]))
    const gaps = frames.slice(1).map((frame, i) => frame.time - frames[i].time).filter((gap) => gap <= 200)
    const slow = gpu.length >= MIN_FRAMES ? median(gpu) > quality.slowGpu : gaps.length >= MIN_FRAMES && median(gaps) > SLOW_GAP
    if (!slow) {
      resting = now + 250 // 判定は間を空けて行う (毎コマ並べ替えない)
      return
    }
    scale *= STEP
    steps++
    apply()
  }

  return {
    update,
    // 止まっている間の倍率で描くか。切り替えたコマで描き直すこと (倍率を変えると画面の中身が消えるため)
    setStill(value: boolean) {
      if (still === value) return
      still = value
      apply()
    },
    get still() {
      return still
    },
    // 動いている間の倍率 (止まっている間も)。「見て分かる動き」の判定の基準にする
    // (今の倍率を基準にすると、くっきり描いた後は判定が細かくなり、カメラの慣性の残りのわずかな動きで軽い倍率に戻ってしまう)
    motionRatio: () => manual ?? motionRatio(),
    // 止まっている間の倍率に対する、今の倍率の比。DoF のボケのように画素の数で大きさを決めている効果を、
    // 動いている間も止まっている間と同じ見かけの大きさにするのに使う
    pixelScale: () => renderer.getPixelRatio() / stillRatio(),
    // 画面の向きや大きさが変わった時に呼ぶ
    fit: () => apply(),
    // GUI で倍率を決める (以後は自動で変えない。止まっても変えない)
    set(value: number) {
      manual = value
      apply()
    },
    // 確認用の表示 (debug.ts) に添える状態
    describe: () => [manual !== undefined ? 'manual' : still ? 'still' : '', steps > 0 ? `auto −${steps}` : ''].filter(Boolean).join(' '),
  }
}
