import '@fontsource/michroma/latin-400.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './hud.css'

// 画面下の操作パネル (HUD)。調整用の lil-gui とは別に、見る人が触る項目だけを作品の一部として置く。
// 値の持ち主は各モジュールのままで、HUD は毎フレーム get() で読み直して表示を合わせる
// (画面をドラッグして autoCamera が切れた時など、HUD の外から値が変わっても追従する)

export interface HudToggle {
  label: string // 見出し (例: DOF)
  detail: string // 小さな補足 (例: Depth of field)
  get(): boolean
  set(value: boolean): void
  available?: boolean // false なら押せない (WebGL2 でのコースティクスなど)
}

export interface HudStatus {
  running: boolean // start 済み
  settled: boolean // 全部止まった
}

export interface HudShortcut {
  key: string // KeyboardEvent.key (小文字)
  label: string
  action(): void
}

// 左上の小さな時刻 (timeOfDay.ts)。time は「18:42」の形、phase で朝・昼・夕・夜の印を選ぶ
export interface HudClock {
  time: string
  phase: 'morning' | 'day' | 'evening' | 'night'
}

export interface HudOptions {
  toggles: HudToggle[] // 前半はスタートボタンの左、後半は右に並ぶ
  camera?: Pick<HudToggle, 'label' | 'get' | 'set'> // 自動カメラ。下の列から離し、右上に小さく置く (C キー)
  start(): void
  status(): HudStatus | undefined // undefined の間は準備中 (物理の読み込み前) として押せない
  shortcuts?: HudShortcut[]
  changed?(): void // HUD で何か切り替えた後に呼ぶ (3D の描き直しの合図)
  ready?: Promise<unknown> // 登場させるきっかけ (読み込み中の幕が上がり始める時。無ければフォントが届き次第)
  clock?(): HudClock // 毎フレーム読む。変わった時だけ表示を書き換える
}

// スタートボタンの図形: ブリリアントカットを真上から見た形 (viewBox 100×100)。
// 外周(ガードル)とテーブル面の八角形を22.5°ずらし、頂点どうしを結んだ線がファセットになる
const octagon = (radius: number, offsetDeg: number) =>
  Array.from({ length: 8 }, (_, k) => {
    const angle = ((k * 45 + offsetDeg) * Math.PI) / 180
    return [50 + radius * Math.cos(angle), 50 - radius * Math.sin(angle)].map((v) => +v.toFixed(2))
  })
const GIRDLE = octagon(46, 22.5)
const TABLE = octagon(26, 0)
const points = (vertices: number[][]) => vertices.map(([x, y]) => `${x},${y}`).join(' ')
const FACETS = TABLE.map(([x, y], k) => {
  const [ax, ay] = GIRDLE[k]
  const [bx, by] = GIRDLE[(k + 7) % 8]
  return `M${ax},${ay}L${x},${y}L${bx},${by}`
}).join('')

// 虹色 (宝石の分散の色)。ON の表示と、スタートボタンの縁に使う
const SPECTRUM = ['#ff5e7e', '#ffb35e', '#f3f27a', '#6effb4', '#5ed8ff', '#7d7bff', '#e07bff']

// 宝石ボタンの線画。待機中はファセットの線を光がひと筋なで (線の形のマスクの中で帯を動かす)、
// 落下中は虹色の光が縁を回り、全部止まると波紋が広がる
const LAUNCH_SVG = `
<svg class="hud-launch__gem" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <linearGradient id="hud-spectrum" x1="0" y1="0" x2="1" y2="1">
      ${SPECTRUM.map((color, i) => `<stop offset="${i / (SPECTRUM.length - 1)}" stop-color="${color}"/>`).join('')}
    </linearGradient>
    <linearGradient id="hud-glint-band">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.95"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="hud-facet-lines">
      <g fill="none" stroke="#fff" stroke-width="1.4">
        <polygon points="${points(GIRDLE)}"/><path d="${FACETS}"/><polygon points="${points(TABLE)}"/>
      </g>
    </mask>
  </defs>
  <polygon class="hud-launch__ripple" points="${points(GIRDLE)}"/>
  <polygon class="hud-launch__ripple" points="${points(GIRDLE)}"/>
  <polygon class="hud-launch__girdle" points="${points(GIRDLE)}" pathLength="100"/>
  <path class="hud-launch__facets" d="${FACETS}"/>
  <polygon class="hud-launch__table" points="${points(TABLE)}"/>
  <g mask="url(#hud-facet-lines)">
    <g transform="rotate(24 50 50)"><rect class="hud-launch__glint" x="0" y="-40" width="36" height="180" fill="url(#hud-glint-band)"/></g>
  </g>
  <polygon class="hud-launch__trace" points="${points(GIRDLE)}" pathLength="100"/>
</svg>
<svg class="hud-launch__icon" viewBox="0 0 24 24" aria-hidden="true">
  <path class="hud-launch__play" d="M9 6.8v10.4l8.2-5.2z"/>
  <g class="hud-launch__restart"><path d="M17.6 9.2A6 6 0 1 0 18 12"/><path d="M18.2 5.4v4h-4"/></g>
</svg>`

// 時間帯の印 (viewBox 24×24 の線画)。4つを重ねておき、今の時間帯のものだけを見せる (切り替わる時はゆっくり入れ替わる)。
// 朝と夕は地平線の上の半分の太陽で、上の山形の向き (昇る・沈む) で見分ける。昼は光を放つ太陽、夜は三日月
// (小さく表示するので、山形と太陽の間は広めに空ける。矢印の軸まで描くと太陽とくっついて見分けにくかった)
const SUN_RAYS = Array.from({ length: 8 }, (_, k) => {
  const angle = (k * Math.PI) / 4
  const [x0, y0, x1, y1] = [6.6, 6.6, 9, 9].map((r, i) => +(12 + r * (i % 2 === 0 ? Math.cos(angle) : Math.sin(angle))).toFixed(2))
  return `M${x0},${y0}L${x1},${y1}`
}).join('')
const PHASE_NAMES: Record<HudClock['phase'], string> = { morning: 'Morning', day: 'Day', evening: 'Evening', night: 'Night' }
const CLOCK_SVG = `
<svg class="hud-clock__mark" viewBox="0 0 24 24" aria-hidden="true">
  <path data-phase="morning" d="M3 18.5h18M7 18.5a5 5 0 0 1 10 0M9 8.5 12 5.5 15 8.5"/>
  <g data-phase="day"><circle cx="12" cy="12" r="3.8"/><path d="${SUN_RAYS}"/></g>
  <path data-phase="evening" d="M3 18.5h18M7 18.5a5 5 0 0 1 10 0M9 5.5 12 8.5 15 5.5"/>
  <path data-phase="night" d="M10.5 4.1A8 8 0 1 0 19.6 14.5 7 7 0 0 1 10.5 4.1z"/>
</svg>`

// 自動カメラの印 (viewBox 24×24 の線画): 宝石 (菱形) の周りを回るカメラの軌道を斜めから見た楕円と、手前のカメラの点
const CAMERA_SVG = `
<svg class="hud-camera__mark" viewBox="0 0 24 24" aria-hidden="true">
  <ellipse cx="12" cy="12" rx="10" ry="4.5"/>
  <path d="M12,9.4 14,12 12,14.6 10,12z"/>
  <circle class="hud-camera__eye" cx="12" cy="16.5" r="1.8"/>
</svg>`

export function createHud({ toggles, camera, start, status, shortcuts = [], changed = () => {}, ready, clock }: HudOptions) {
  const root = document.createElement('div')
  root.className = 'hud'
  const deck = document.createElement('div')
  deck.className = 'hud-deck'
  root.append(deck)

  const span = (className: string, text = '') => {
    const element = document.createElement('span')
    element.className = className
    element.textContent = text
    return element
  }

  // タイルは2段: 見出しと状態の印 / 補足。ON・OFF は印と下端の線(ON で虹色)で表す
  // (狭い画面ではスタートボタンの左右に縦に積むので、左右どちらの何段目かを持たせておく)
  const half = Math.ceil(toggles.length / 2)
  deck.style.setProperty('--hud-rows', String(half))
  const flip = (toggle: Pick<HudToggle, 'get' | 'set'>) => {
    toggle.set(!toggle.get())
    changed()
  }
  const toggleViews = toggles.map((toggle, i) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'hud-toggle'
    button.dataset.side = i < half ? 'left' : 'right'
    button.style.setProperty('--hud-row', String((i % half) + 1))
    const main = span('hud-toggle__main')
    main.append(span('hud-toggle__label', toggle.label), span('hud-toggle__led'))
    const unavailable = toggle.available === false
    const detail = span('hud-toggle__detail', unavailable ? 'WebGPU only' : toggle.detail)
    button.append(main, detail, span('hud-toggle__bar'))
    button.title = `${toggle.label} (${i + 1})`
    button.disabled = unavailable
    button.addEventListener('click', () => flip(toggle))
    // ポインターの位置にだけガラスに柔らかい光を乗せる (hud.css の .hud-toggle::before)
    button.addEventListener('pointermove', (event) => {
      const rect = button.getBoundingClientRect()
      button.style.setProperty('--hud-mx', `${event.clientX - rect.left}px`)
      button.style.setProperty('--hud-my', `${event.clientY - rect.top}px`)
    })
    return { toggle, button, shown: undefined as boolean | undefined }
  })

  const launch = document.createElement('button')
  launch.type = 'button'
  launch.className = 'hud-launch'
  launch.title = 'Start (Space)'
  const gem = span('hud-launch__frame')
  gem.innerHTML = LAUNCH_SVG
  // 線画の後ろのすりガラス。ガードルの八角形で切り抜く
  const glass = span('hud-launch__glass')
  glass.style.clipPath = `polygon(${GIRDLE.map(([x, y]) => `${x}% ${y}%`).join(', ')})`
  gem.prepend(glass)
  const launchLabel = span('hud-launch__label')
  launch.append(gem, launchLabel)
  // 押した瞬間にファセットを光らせる (クラスを付け直してアニメーションを最初から再生する)
  const fire = () => {
    if (launch.disabled) return
    start()
    changed()
    launch.classList.remove('is-firing')
    void launch.offsetWidth
    launch.classList.add('is-firing')
  }
  launch.addEventListener('click', fire)

  // 待機中 (押す前と止まった後) は、7秒おきに光の帯がファセットの線をなでる。
  // CSS の無限ループにすると、光っていない間もブラウザが毎フレーム描き直すので、1回ずつ再生する
  setInterval(() => {
    if (launch.dataset.state !== 'ready' && launch.dataset.state !== 'settled') return
    launch.classList.remove('is-glinting')
    void launch.offsetWidth
    launch.classList.add('is-glinting')
  }, 7000)

  // 右上の自動カメラ: 左上の時刻と対にして、同じくらい小さく置く (タイルのガラスや括弧は付けない)
  const cameraView = camera && (() => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'hud-camera'
    button.title = `${camera.label} (C)`
    button.append(span('hud-camera__label', camera.label))
    button.insertAdjacentHTML('beforeend', CAMERA_SVG)
    button.addEventListener('click', () => flip(camera))
    root.append(button)
    return { button, shown: undefined as boolean | undefined }
  })()

  const items = [...toggleViews.slice(0, half).map((view) => view.button), launch, ...toggleViews.slice(half).map((view) => view.button)]
  items.forEach((item, i) => item.style.setProperty('--hud-order', String(i)))
  deck.append(...items)

  const hints = [
    [`1–${toggleViews.length}`, 'Toggle'],
    ['Space', 'Start'],
    ...(camera ? [['C', 'Camera']] : []),
    ...shortcuts.map(({ key, label }) => [key.toUpperCase(), label]),
  ]
  const hint = span('hud-hint')
  for (const [key, label] of hints) {
    const kbd = document.createElement('kbd')
    kbd.textContent = key
    const entry = span('hud-hint__entry')
    entry.append(kbd, label)
    hint.append(entry)
  }
  root.append(hint)

  // 左上の時刻: 時間帯の印 | 18:42
  const clockView = clock && (() => {
    const element = span('hud-clock')
    element.setAttribute('role', 'img')
    const mark = span('hud-clock__frame')
    mark.innerHTML = CLOCK_SVG
    const time = document.createElement('time')
    time.className = 'hud-clock__time'
    element.append(mark, time)
    root.append(element)
    return { element, time, shown: '' }
  })()
  document.body.append(root)

  // フォントが届く前に出すと、差し替わる時に文字の幅が変わってがたつくので、読み込みを待ってから登場させる
  // (届かなくても1.5秒で出す)。幕の裏で登場のアニメーションを済ませてしまわないよう、ready も待つ
  const fonts = Promise.race([
    Promise.all([document.fonts.load('11px Michroma'), document.fonts.load('9px "JetBrains Mono"')]),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]).catch(() => {})
  Promise.all([fonts, ready]).then(() => root.classList.add('is-ready'))

  // lil-gui の入力欄などで打っている文字は拾わない
  addEventListener('keydown', (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable]')) return
    if (/^[1-9]$/.test(event.key)) {
      const view = toggleViews[Number(event.key) - 1]
      if (view && view.toggle.available !== false) flip(view.toggle)
    } else if (event.code === 'Space') {
      // フォーカス中のボタンはブラウザが Space で押すので、二重に動かさない
      if (target instanceof HTMLButtonElement) return
      event.preventDefault()
      fire()
    } else if (camera && event.key.toLowerCase() === 'c') {
      flip(camera)
    } else {
      shortcuts.find((shortcut) => shortcut.key === event.key.toLowerCase())?.action()
    }
  })

  let phase = ''
  // 毎フレーム呼ぶ。表示が変わる所だけ DOM を書き換える
  function update() {
    for (const view of toggleViews) {
      if (view.toggle.available === false) continue
      const on = view.toggle.get()
      if (on === view.shown) continue
      view.shown = on
      view.button.setAttribute('aria-pressed', String(on))
    }
    const cameraOn = camera?.get()
    if (cameraView && cameraOn !== cameraView.shown) {
      cameraView.shown = cameraOn
      cameraView.button.setAttribute('aria-pressed', String(cameraOn))
    }

    const current = status()
    const next = !current ? 'loading' : current.settled ? 'settled' : current.running ? 'running' : 'ready'
    if (next !== phase) {
      phase = next
      launch.dataset.state = phase
      root.dataset.phase = phase // 虹色の線は落下中だけ流す (hud.css)
      launch.disabled = phase === 'loading'
      launchLabel.textContent = phase === 'ready' || phase === 'loading' ? 'Start' : 'Restart'
    }

    if (clock && clockView) {
      const { time, phase: dayPhase } = clock()
      const shown = `${time} ${dayPhase}`
      if (shown !== clockView.shown) {
        clockView.shown = shown
        clockView.time.textContent = time
        clockView.time.dateTime = time
        clockView.element.dataset.phase = dayPhase
        clockView.element.setAttribute('aria-label', `${PHASE_NAMES[dayPhase]} ${time}`)
      }
    }
  }

  // 宝石を突いた位置に、宝石ボタンと同じ八角形の波紋を出す (poke.ts のタップ)
  function ripple(x: number, y: number) {
    const mark = span('hud-tap')
    mark.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><polygon points="${points(GIRDLE)}"/><polygon points="${points(GIRDLE)}"/></svg>`
    mark.style.left = `${x}px`
    mark.style.top = `${y}px`
    root.append(mark)
    setTimeout(() => mark.remove(), 1200) // 動きを減らす設定でアニメーションが無い時も消えるよう、時間で消す
  }

  update()
  return { update, ripple }
}
