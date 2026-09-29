// 読み込み中の幕 (index.html の .loader、見た目は loader.css)。
// 最初の絵を出す条件 (steps) がそろうまで画面を覆い、そろったら幕を上げる。
// JS が届く前から出したいので、幕そのものは index.html に直接書いてあり、ここでは進み具合と上げ下ろしだけを扱う。
// 進み具合は、宝石の外周 (ガードル) の線が描かれた長さで表す (そろった条件の数 / 全部の数)

// 幕を上げ終わるまでの時間 (loader.css の .is-done で一番遅く終わる、幕の地の遅れ 250ms + 長さ 1000ms)
const HIDE_MS = 1250

export function createLoader<Step extends string>(steps: readonly Step[]) {
  const root = document.querySelector<HTMLElement>('.loader')!
  const progress = root.querySelector<SVGElement>('.loader__progress')!
  const caption = root.querySelector<HTMLElement>('.loader__caption')!
  const met = new Set<Step>()
  let failed = false
  let resolveReady!: () => void
  // 条件が全部そろった時に解決する
  const ready = new Promise<void>((resolve) => (resolveReady = resolve))

  // 条件が1つそろった (同じ条件を何度呼んでもよい)
  function complete(step: Step) {
    if (failed || met.has(step)) return
    met.add(step)
    const ratio = met.size / steps.length
    progress.style.strokeDashoffset = String(100 * (1 - ratio))
    root.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
    if (met.size === steps.length) resolveReady()
  }

  // 読み込めなかった。幕を下ろしたまま理由を出す。retry なら、画面を押すと読み込み直す
  function fail(error: unknown, message = 'Failed to load · Tap to reload', retry = true) {
    if (failed) return
    failed = true
    console.error(error)
    root.classList.add('is-failed')
    caption.textContent = message
    if (retry) root.addEventListener('click', () => location.reload())
  }

  // 幕を上げる。上げ終わったら幕を取り除いて解決する
  // (時間で進めるのは、タブが裏にあってアニメーションが進まない時も止まらないようにするため)
  function hide() {
    root.classList.add('is-done')
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        root.remove()
        resolve()
      }, HIDE_MS),
    )
  }

  return { ready, complete, fail, hide }
}
