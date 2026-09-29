// 端末ごとの画質の設定。負荷に効く値 (解像度・サンプル数・光線の本数) をここに集め、起動時にどちらかの組を選ぶ。
// スマホは画面が小さく画素が細かいので、効果の種類は PC と同じにしたまま、計算の細かさだけを落とす
// (効果そのものを消すと別の作品に見えるため)。
// 指で操作する端末 (pointer: coarse) をスマホとみなす。URL で上書きできる:
// ?quality=mobile で PC からスマホの設定を確かめる、?quality=desktop でスマホから PC の設定と見比べる

type Quality = {
  maxPixelRatio: number // 描画倍率の上限。止まっている間は、画面本来の倍率とこの小さい方で描く (resolution.ts)
  motionPixels: number // 動いている間に描く画素の数の上限。これに収まるよう、動いている間は描画倍率を下げる (resolution.ts)
  slowGpu: number // 動いている間の GPU の時間 (中央値) がこれ (ms) を超える状態が続いたら、動いている間の倍率を自動で下げる
  reflectionScale: number // 床の映り込みを描く解像度 (画面に対する倍率)
  reflectionTaps: number // 映り込みをぼかすサンプル数
  starScale: number // 光条を計算する解像度 (画面に対する倍率)
  starSamples: number // 光条の1方向あたりのサンプル数
  dofScale: number // DoF のボケを計算する解像度 (画面に対する倍率)
  causticsRaysPerSide: number // コースティクスで宝石1個に撃つ光線の数 (縦×横)
  fps: number // 動いている間に描く回数の上限 (1秒あたり)
}

const PRESETS = {
  desktop: {
    maxPixelRatio: Infinity, // 画面本来の解像度 (外部の1080pモニターでは等倍、内蔵Retinaでは2倍)
    // 動いている間は300万画素まで (Retina の MacBook で約1.44倍。1080p の外部モニターは等倍のまま変わらない)。
    // M1 Max の実測から見積もると、Retina で一番重い場面の GPU の時間が約4割減る (家庭用の PC でファンを回しすぎないように)
    motionPixels: 3_000_000,
    // GPU の7割。PC は60fpsに届いていても、GPU を使い切る状態が続くとファンが回るので、スマホより早めに下げる
    slowGpu: 12,
    reflectionScale: 0.5,
    reflectionTaps: 16,
    starScale: 0.5,
    starSamples: 48,
    dofScale: 0.5, // DepthOfFieldNode の元のまま
    causticsRaysPerSide: 96,
    fps: 60,
  },
  mobile: {
    // 止まっている間の倍率。iPhone は画面の3倍の細かさで、そのまま描くと縦向きで約316万画素。1.5倍なら1/4で済む
    // (止まっている間は1回描くだけなので重くても構わないが、それ以上細かくしても見分けにくい)
    maxPixelRatio: 1.5,
    // 宝石が画面いっぱいの一番重い場面でも60fpsを保てる量 (?bench で測った iPhone 16 Pro・iPad の値から見積もった。
    // この量で GPU は iPhone 約12ms・iPad 約14ms)。動いている間は iPhone 16 Pro で約1.3倍、11インチの iPad の横向きで約0.77倍になる。
    // ユーザーの方針: スマホでは細かさより滑らかさ・快適さを優先する
    motionPixels: 500_000,
    slowGpu: 18, // 60fps の持ち時間 (16.7ms) に収まらない状態
    reflectionScale: 0.25,
    reflectionTaps: 8,
    starScale: 0.25,
    // 光条の解像度を下げた分、サンプルを半分にしても、筋に沿ったサンプルの間隔 (光条の画像の画素で数えて) は PC より広くならない
    starSamples: 24,
    dofScale: 0.25, // ボケとピントの境目が少し粗くなる
    causticsRaysPerSide: 64,
    fps: 60,
  },
} satisfies Record<string, Quality>

type QualityName = keyof typeof PRESETS

const requested = new URLSearchParams(location.search).get('quality')
const name: QualityName =
  requested === 'desktop' || requested === 'mobile' ? requested : matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop'

export const quality: Quality & { name: QualityName } = { name, ...PRESETS[name] }
