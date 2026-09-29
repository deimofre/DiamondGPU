// 止まってくっきり描き直す時 (resolution.ts) の切り替えを、溶かすように見せる。
// 倍率を上げると、くっきり具合だけでなく、粒子・光条・ブルームなど画素の大きさで見え方が決まる効果も一度に変わり、
// 止まる直前と止まった瞬間で絵がはっきり入れ替わって見えた (ユーザーの指摘)。
// そこで、直前の軽い絵を 2D のキャンバスに写し取って画面の上に重ね、CSS で徐々に透明にする。
// 溶かしている間、3D 側は何も描かない (くっきりした絵を1回描くだけ) ので、負荷はほぼ無い
const DURATION = 500 // 溶かす時間 (ms)

// verify: 写し取れたかを確かめて result に残す (確認用の表示 ?debug のため。1画素を読み戻すので普段はしない)
export function createCrossfade(source: HTMLCanvasElement, parent: HTMLElement, verify = false) {
  const overlay = document.createElement('canvas')
  overlay.className = 'crossfade'
  overlay.hidden = true
  parent.append(overlay)
  const context = overlay.getContext('2d', { willReadFrequently: false })
  let hideTimer = 0
  let result = '' // 最後に写し取った結果 (fade ok / fade blank / fade error)

  // 溶かし終えたら隠して、画像も手放す (透明のまま重ねておくと、画面を重ね合わせる手間が毎コマかかるため)
  function hide() {
    clearTimeout(hideTimer)
    overlay.hidden = true
    overlay.width = overlay.height = 0
  }

  return {
    // source の今の絵を写し取って重ねる。source に描いた直後、同じコマの中で呼ぶこと
    // (WebGPU の画面は、そのコマを表示すると中身を読めなくなるため)。写し取れなければ何もしない (今までどおりの切り替わりになる)
    capture() {
      if (!context) return
      hide()
      overlay.width = source.width
      overlay.height = source.height
      try {
        context.drawImage(source, 0, 0)
      } catch {
        overlay.width = overlay.height = 0
        result = 'fade error'
        return
      }
      if (verify) {
        const alpha = context.getImageData(overlay.width >> 1, overlay.height >> 1, 1, 1).data[3]
        result = alpha > 0 ? 'fade ok' : 'fade blank' // blank: 写し取れたが中身が空 (その端末では溶かせない)
      }
      overlay.style.transition = 'none'
      overlay.style.opacity = '1'
      overlay.hidden = false
    },
    // 溶かし始める (下のキャンバスにくっきりした絵を描いた後に呼ぶ)。重ねた絵を一度表示してから透明にしていく
    fadeOut() {
      if (overlay.hidden) return
      requestAnimationFrame(() => {
        overlay.style.transition = `opacity ${DURATION}ms cubic-bezier(0.4, 0, 0.2, 1)`
        overlay.style.opacity = '0'
        hideTimer = window.setTimeout(hide, DURATION + 50)
      })
    },
    // 溶かしている途中で動き出したら、すぐ消す
    cancel() {
      if (!overlay.hidden) hide()
    },
    get result() {
      return result
    },
  }
}
