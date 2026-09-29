import * as THREE from 'three/webgpu'
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js'

// 時刻による光の移ろい
//
// 見る人の端末の時計に合わせて、スタジオの光を変える。さりげない遊び心なので、極端にはしない
// (夜に見た人と昼に見た人で、違う絵になる。最初は控えめにしすぎて「薄い」と言われ、昼を明るく強めた)。
// 設定は「暗い撮影スタジオに窓が1つある」:
// - 夜: 窓の外は暗く、今までどおりのスタジオの照明だけ (変化は0)
// - 朝・昼・夕方: 窓から外の光が入る (studio.ts の窓)。キーライトが太陽の役になり、時刻で色・強さ・高さ・方位が動く
//   (朝は澄んだ白、昼は明るく少し高く、夕方は低く橙に)。背景の中心と外側の色も一緒に移る (stage.ts)
// キーライトはコースティクスの光源でもあるので、床の光の模様も時刻で少し伸び縮みし、向きを変える。
// 部屋(壁)の暗さは変えない。明るくすると宝石の面が全部明るく映り、暗い面が無くなって色ガラスのように見える (studio.ts)。
// 日の出・日の入りは日付から計算する (季節で変わる)。見る人の場所は調べない
// (位置情報の許可を求めると体験を損なうので、日本の真ん中あたりの緯度と南中時刻で近似する)。
// URL に ?time=17:30 を付けると、その時刻で確かめられる
const LATITUDE = 35 // 度 (東京 35.7°・大阪 34.7°)
const SOLAR_NOON = 11.75 // 太陽が一番高くなる時刻 (日本の標準時で、東京〜大阪あたりの年平均)
const MORNING_END = 10 // 印を朝から昼に替える時刻
const CHECK_INTERVAL = 1000 // 時計を見る間隔 (ms)。光を変えるのは分が変わった時だけ

export type DayPhase = 'morning' | 'day' | 'evening' | 'night'

type Sun = { rise: number; noon: number; set: number } // 時刻 (時)

// 時間帯ごとの見え方。節目の間は直線で補間し、最初の節目より前と最後の節目より後は夜 (NIGHT)
type Look = {
  light: string // キーライトの色
  intensity: number // キーライトの強さの倍率 (夜の強さに掛ける。床の模様の明るさも変わる)
  elevation: number // キーライトの高さのずれ (度。夜の高さに足す)
  azimuth: number // 方位のずれ (度。正が朝の側)
  sky: string // 窓の色
  skyIntensity: number // 窓の明るさ (ソフトボックスは 6)
  // 背景の中心と外側に掛ける色 (リニア。1 でそのまま)。別々にして、夕方は中心が暖かく外側が紫がかるなど、空のような移りを付ける
  center: [number, number, number]
  edge: [number, number, number]
}
const NIGHT: Look = { light: '#ffffff', intensity: 1, elevation: 0, azimuth: 0, sky: '#000000', skyIntensity: 0, center: [1, 1, 1], edge: [1, 1, 1] }
const KEYS: { at: (sun: Sun) => number; look: Look }[] = [
  { at: (sun) => sun.rise - 1, look: NIGHT },
  // 夜明け前: 窓の外と背景が青くなり始める
  { at: (sun) => sun.rise - 0.3, look: {
    light: '#dfe6ff', intensity: 0.9, elevation: -2, azimuth: 18, sky: '#6f7fd0', skyIntensity: 0.8,
    center: [1.15, 1.3, 1.7], edge: [1.2, 1.4, 1.8] } },
  // 朝焼け: 低い光が暖かく、背景の中心は桃色、外側は薄紫
  { at: (sun) => sun.rise + 0.6, look: {
    light: '#ffc89a', intensity: 1, elevation: -3, azimuth: 16, sky: '#ffc4a0', skyIntensity: 2,
    center: [2, 1.6, 1.4], edge: [1.7, 1.4, 1.45] } },
  // 朝: 澄んだ白。背景は明るく青みがかる
  { at: (sun) => sun.rise + 2.5, look: {
    light: '#eef3ff', intensity: 1.15, elevation: 2, azimuth: 11, sky: '#d4e3ff', skyIntensity: 2.6,
    center: [2.1, 2.25, 2.4], edge: [2.3, 2.5, 2.3] } },
  // 昼: 一番明るい。光が少し高く (床の模様が短くなる)、背景は外側まで明るく平らに
  { at: (sun) => sun.noon, look: {
    light: '#fffaf2', intensity: 1.3, elevation: 8, azimuth: 0, sky: '#eef3ff', skyIntensity: 3,
    center: [2.7, 2.75, 2.6], edge: [3.1, 3.2, 2.5] } },
  // 午後: 少しずつ暖かく
  { at: (sun) => sun.set - 2.5, look: {
    light: '#ffeed6', intensity: 1.2, elevation: 2, azimuth: -11, sky: '#ffeccf', skyIntensity: 2.6,
    center: [2.5, 2.35, 2.05], edge: [2.7, 2.55, 2.1] } },
  // 夕方: 低い橙の光 (床の模様が長く伸びる)。背景の中心は橙がかり、外側は紫
  { at: (sun) => sun.set - 0.6, look: {
    light: '#ffa862', intensity: 1.05, elevation: -3, azimuth: -16, sky: '#ffa870', skyIntensity: 2.2,
    center: [2.5, 1.6, 1.05], edge: [2.2, 1.35, 1.25] } },
  // 日没の後: 窓の外と背景が赤紫に
  { at: (sun) => sun.set + 0.3, look: {
    light: '#ff8c64', intensity: 0.95, elevation: -3, azimuth: -18, sky: '#d4808f', skyIntensity: 1.2,
    center: [1.9, 1.25, 1.3], edge: [1.55, 1.1, 1.45] } },
  // 夜の始まり: 青く沈む
  { at: (sun) => sun.set + 0.7, look: {
    light: '#e6eaff', intensity: 0.95, elevation: -1, azimuth: -9, sky: '#6c6cc0', skyIntensity: 0.6,
    center: [1.2, 1.15, 1.45], edge: [1.25, 1.2, 1.5] } },
  { at: (sun) => sun.set + 1.2, look: NIGHT },
]

// 色は読み込み時に一度だけリニアに直しておく
type Mixed = {
  light: THREE.Color; intensity: number; elevation: number; azimuth: number; sky: THREE.Color; skyIntensity: number
  center: THREE.Color; edge: THREE.Color
}
const toMixed = (look: Look): Mixed => ({
  light: new THREE.Color(look.light),
  intensity: look.intensity,
  elevation: look.elevation,
  azimuth: look.azimuth,
  sky: new THREE.Color(look.sky),
  skyIntensity: look.skyIntensity,
  center: new THREE.Color().setRGB(...look.center),
  edge: new THREE.Color().setRGB(...look.edge),
})
const keys = KEYS.map(({ at, look }) => ({ at, look: toMixed(look) }))

// その日の日の出・日の入りの時刻。赤緯を日付からざっくり求め、cos(時角) = -tan(緯度)·tan(赤緯) で昼の長さを出す
function sunTimes(date: Date): Sun {
  const dayOfYear = (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 86_400_000
  const declination = THREE.MathUtils.degToRad(-23.44 * Math.cos(((dayOfYear + 10) / 365) * Math.PI * 2))
  const cosHourAngle = -Math.tan(THREE.MathUtils.degToRad(LATITUDE)) * Math.tan(declination)
  // 大気の屈折と太陽の大きさの分、日の出は約6分早く、日の入りは約6分遅い
  const halfDay = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(cosHourAngle, -1, 1))) / 15 + 0.1
  return { rise: SOLAR_NOON - halfDay, noon: SOLAR_NOON, set: SOLAR_NOON + halfDay }
}

function phaseAt(hour: number, sun: Sun): DayPhase {
  if (hour >= sun.rise - 0.5 && hour < MORNING_END) return 'morning'
  if (hour >= MORNING_END && hour < sun.set - 1.5) return 'day'
  if (hour >= sun.set - 1.5 && hour < sun.set + 1) return 'evening'
  return 'night'
}

// ?time=17:30 (または ?time=17) を時刻 (時) に直す
function parseTime(text: string | null) {
  const match = text?.match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (!match) return undefined
  const hour = Number(match[1]) + Number(match[2] ?? 0) / 60
  return hour < 24 ? hour : undefined
}

const formatTime = (hour: number) => {
  const minutes = Math.floor(hour * 60 + 1e-6) % 1440
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

// 0 を下回らないように混ぜる (amount が 1 を超えると、白から離れる向きに行き過ぎるため)
function mixColor(out: THREE.Color, from: THREE.Color, to: THREE.Color, t: number) {
  out.lerpColors(from, to, t)
  out.setRGB(Math.max(out.r, 0), Math.max(out.g, 0), Math.max(out.b, 0))
  return out
}

export function createTimeOfDay(
  light: THREE.DirectionalLight, // キーライト (コースティクスの光源)
  targets: {
    setWindow(color: THREE.Color, intensity: number): void // studio.ts の窓
    setBackgroundTint(center: THREE.Color, edge: THREE.Color): void // stage.ts の背景 (中心と外側)
  },
  gui: GUI,
) {
  // 夜のキーライトの向きは main.ts で置いた向き (朝・昼・夕方はここから少しずれる)
  const spherical = new THREE.Spherical().setFromVector3(light.position.clone().sub(light.target.position))
  const base = {
    azimuth: THREE.MathUtils.radToDeg(spherical.theta),
    elevation: 90 - THREE.MathUtils.radToDeg(spherical.phi),
    intensity: light.intensity,
  }

  const override = parseTime(new URLSearchParams(location.search).get('time'))
  // clock: 端末の時計に合わせる / hour: 使う時刻 (時) / amount: 変化の強さ (0 でいつも夜の見た目)。
  // amount は KEYS の値を夜からどれだけ離すかの倍率。1.3 はユーザーが GUI で見て決めた値
  // (1 を超えた分は、色は白から離れる向きに行き過ぎて鮮やかになる。負にならないよう mixColor で止めている)
  const state = { clock: override === undefined, hour: override ?? 0, amount: 1.3 }
  // HUD の時刻の表示 (hud.ts が毎フレーム読む)
  const display: { time: string; phase: DayPhase } = { time: '', phase: 'night' }

  const mixed = toMixed(NIGHT)
  const white = new THREE.Color(1, 1, 1)
  const center = new THREE.Color()
  const edge = new THREE.Color()

  // 時刻の見え方を、前後の節目から補間して mixed に入れる
  function sample(hour: number, sun: Sun) {
    const times = keys.map((key) => key.at(sun))
    const next = times.findIndex((time) => time > hour)
    if (next <= 0) return Object.assign(mixed, toMixed(NIGHT)) // 最初の節目より前・最後の節目より後
    const from = keys[next - 1].look
    const to = keys[next].look
    const t = (hour - times[next - 1]) / (times[next] - times[next - 1])
    const lerp = (a: number, b: number) => THREE.MathUtils.lerp(a, b, t)
    mixed.light.lerpColors(from.light, to.light, t)
    mixed.intensity = lerp(from.intensity, to.intensity)
    mixed.elevation = lerp(from.elevation, to.elevation)
    mixed.azimuth = lerp(from.azimuth, to.azimuth)
    mixed.sky.lerpColors(from.sky, to.sky, t)
    mixed.skyIntensity = lerp(from.skyIntensity, to.skyIntensity)
    mixed.center.lerpColors(from.center, to.center, t)
    mixed.edge.lerpColors(from.edge, to.edge, t)
    return mixed
  }

  function apply() {
    const sun = sunTimes(new Date())
    const look = sample(state.hour, sun)
    const { amount } = state
    mixColor(light.color, white, look.light, amount)
    light.intensity = base.intensity * Math.max(THREE.MathUtils.lerp(1, look.intensity, amount), 0)
    const elevation = THREE.MathUtils.clamp(base.elevation + look.elevation * amount, 1, 89)
    const azimuth = base.azimuth + look.azimuth * amount
    light.position
      .setFromSphericalCoords(spherical.radius, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth))
      .add(light.target.position)
    targets.setWindow(look.sky, look.skyIntensity * amount)
    targets.setBackgroundTint(mixColor(center, white, look.center, amount), mixColor(edge, white, look.edge, amount))
    display.time = formatTime(state.hour)
    display.phase = phaseAt(state.hour, sun)
  }

  let lastCheck = -Infinity
  let applied = ''
  // 毎フレーム、描画の前に呼ぶ。光を変えた時は true (描き直しの合図)
  function update() {
    const now = performance.now()
    if (state.clock && now - lastCheck >= CHECK_INTERVAL) {
      lastCheck = now
      const date = new Date()
      state.hour = date.getHours() + date.getMinutes() / 60
    }
    const signature = [state.hour, state.amount, base.azimuth, base.elevation, base.intensity].join(',')
    if (signature === applied) return false
    applied = signature
    apply()
    if (state.clock) hourController.updateDisplay()
    return true
  }

  const folder = gui.addFolder('Time')
  const clockController = folder.add(state, 'clock').name('follow clock').onChange(() => (lastCheck = -Infinity))
  // 時刻を動かすと、時計に合わせるのをやめる
  const hourController = folder.add(state, 'hour', 0, 24, 1 / 60).onChange(() => {
    state.clock = false
    clockController.updateDisplay()
  })
  folder.add(state, 'amount', 0, 2)
  // 夜のキーライトの向きと強さ (以前は Caustics の light azimuth / light elevation / light intensity にあった)
  folder.add(base, 'azimuth', -180, 180).name('light azimuth')
  folder.add(base, 'elevation', 5, 90).name('light elevation')
  folder.add(base, 'intensity', 0, 10).name('light intensity')

  update()
  return { update, display }
}
