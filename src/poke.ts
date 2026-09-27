import * as THREE from 'three/webgpu'

// 宝石をタップして突く操作。カメラ操作 (OrbitControls) とは「押してから離すまでに動かした距離」で分ける:
// - ほとんど動かさずに離した → タップ。宝石に当たっていれば onPoke
// - 一定以上動かした・2本指で触れた・ホイールを回した → カメラ操作。onCameraInput (autoCamera を切るのに使う)
// OrbitControls は押した瞬間に操作を始めるので、タップの小さな手ぶれでもわずかに回るが、見て分かるほどではない
const TAP_SLOP = 8 // この距離 (px) 以上動いたらドラッグとみなす
const TAP_TIME = 500 // これより長く (ms) 押していたらタップとみなさない

export interface GemPokeOptions {
  element: HTMLElement // レンダラーのキャンバス
  camera: THREE.Camera
  targets(): THREE.Object3D[] // 突ける物 (宝石)
  onPoke(hit: THREE.Intersection, ray: THREE.Ray, event: PointerEvent): void
  onCameraInput(): void
}

export function createGemPoke({ element, camera, targets, onPoke, onCameraInput }: GemPokeOptions) {
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const down = new Map<number, { x: number; y: number; time: number }>() // 押している指・ボタン
  let tapCandidate: number | undefined // タップになりうる指 (1本目で、まだ動かしていない)

  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      onCameraInput() // 右ボタン・中ボタンはパンやズーム
      return
    }
    down.set(event.pointerId, { x: event.clientX, y: event.clientY, time: event.timeStamp })
    if (down.size === 1) {
      tapCandidate = event.pointerId
    } else {
      tapCandidate = undefined // 2本指 (ピンチ・パン)
      onCameraInput()
    }
  })

  element.addEventListener('pointermove', (event) => {
    const start = down.get(event.pointerId)
    if (!start || event.pointerId !== tapCandidate) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= TAP_SLOP) {
      tapCandidate = undefined
      onCameraInput()
    }
  })

  const release = (event: PointerEvent) => {
    const start = down.get(event.pointerId)
    down.delete(event.pointerId)
    if (event.type !== 'pointerup' || !start || event.pointerId !== tapCandidate) return
    tapCandidate = undefined
    if (event.timeStamp - start.time > TAP_TIME) return

    const rect = element.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(targets(), false)[0]
    if (hit) onPoke(hit, raycaster.ray, event)
  }
  element.addEventListener('pointerup', release)
  element.addEventListener('pointercancel', release)

  element.addEventListener('wheel', () => onCameraInput(), { passive: true })
}
