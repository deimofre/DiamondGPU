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

export interface HudOptions {
  toggles: HudToggle[] // 前半はスタートボタンの左、後半は右に並ぶ
  start(): void
  status(): HudStatus | undefined // undefined の間は準備中 (物理の読み込み前) として押せない
  shortcuts?: HudShortcut[]
  changed?(): void // HUD で何か切り替えた後に呼ぶ (3D の描き直しの合図)
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


export function createHud({ toggles, start, status, shortcuts = [], changed = () => {} }: HudOptions) {
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
  const flip = (toggle: HudToggle) => {
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

  const items = [...toggleViews.slice(0, half).map((view) => view.button), launch, ...toggleViews.slice(half).map((view) => view.button)]
  items.forEach((item, i) => item.style.setProperty('--hud-order', String(i)))
  deck.append(...items)

  const hints = [
    [`1–${toggleViews.length}`, 'Toggle'],
    ['Space', 'Start'],
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
  document.body.append(root)

  // フォントが届く前に出すと、差し替わる時に文字の幅が変わってがたつくので、読み込みを待ってから登場させる
  // (届かなくても1.5秒で出す)
  Promise.race([
    Promise.all([document.fonts.load('11px Michroma'), document.fonts.load('9px "JetBrains Mono"')]),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]).finally(() => root.classList.add('is-ready'))

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

    const current = status()
    const next = !current ? 'loading' : current.settled ? 'settled' : current.running ? 'running' : 'ready'
    if (next !== phase) {
      phase = next
      launch.dataset.state = phase
      root.dataset.phase = phase // 虹色の線は落下中だけ流す (hud.css)
      launch.disabled = phase === 'loading'
      launchLabel.textContent = phase === 'ready' || phase === 'loading' ? 'Start' : 'Restart'
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
