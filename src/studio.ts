import * as THREE from 'three/webgpu'
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js'

// 撮影スタジオの照明 (環境マップ)
//
// ジュエリー撮影と同じく、暗い部屋に照明を数灯だけ置く。宝石の面は「照明が映る面は明るく、暗い部屋が映る面は黒く沈む」
// ので、この明暗の交互が輝きになる (均一に明るい部屋だと全部の面が明るくなり、色ガラスのように見える)。
// - キーライト: コースティクスと同じ平行光源の方向に置く、小さく強い光。宝石の中を通って出てくるきらめきと、
//   床のコースティクスが同じ光から生まれるようにする。見かけの大きさはコースティクスの light size と同じにし、
//   明るさは平行光源と同じ照度になるように決める (輝度 = 照度 ÷ 見かけの面積(立体角))
// - ソフトボックス: 真上と左右に置く大きく柔らかい光。宝石全体の明るさを作る
// - ストリップライト: 真上を中心に放射状に並べた細長い光 (傘の骨のように、仰角 25°〜70° に渡す)。
//   上面のファセットに白い筋と暗い部屋が交互に映り込み、宝石や視点が動くと筋が面から面へ移ってきらめく
//   (ジュエリー撮影で細長い光と黒い板を交互に置くのと同じ。筋の間の暗い部屋が黒い板の役をする)
// - 床: 黒 (実際の床は黒い鏡)
// 映り込みと宝石の中を通る光(gemTracer.ts)にだけ使われ、画面の背景は stage.ts のグラデーションのまま。
// ライトの向き・大きさ・GUIの値が変わった時だけ作り直す (PMREMへの変換は数ms)。毎フレームの負荷は無い
const DISTANCE = 8 // 照明を置く距離
const FLOOR_Y = -0.35 // 環境マップは原点から撮るので、着地した宝石の中心(y≈0.35)から見た床の高さ

export function createStudio(
  renderer: THREE.WebGPURenderer,
  light: THREE.DirectionalLight,
  getLightSize: () => number, // キーライトの見かけの半径 (度)
  gui: GUI,
) {
  const params = { softbox: 6, room: 0.2, strips: 4, stripCount: 8, stripWidth: 0.3 }
  const environmentScene = new THREE.Scene()

  const roomMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide })
  environmentScene.add(new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), roomMaterial))
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: 0x000000 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = FLOOR_Y
  environmentScene.add(floor)

  // ソフトボックス (位置, 幅, 高さ, softbox の値に対する明るさの比)
  const softboxes: { material: THREE.MeshBasicMaterial; gain: number }[] = []
  const addSoftbox = (position: [number, number, number], width: number, height: number, gain: number) => {
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    const box = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
    box.position.set(...position)
    box.lookAt(0, 0, 0)
    environmentScene.add(box)
    softboxes.push({ material, gain })
  }
  addSoftbox([0, DISTANCE, 0], 5, 5, 1) // 真上
  addSoftbox([-6, 2.5, 4], 1.5, 5, 1.5) // 左前の細長い光
  addSoftbox([5, 2, -5], 1.5, 5, 1) // 右奥の細長い光

  // ストリップライト。本数と幅が変わった時は作り直す
  const STRIP_FROM = THREE.MathUtils.degToRad(25) // 下端の仰角
  const STRIP_TO = THREE.MathUtils.degToRad(70) // 上端の仰角
  const stripMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const strips = new THREE.Group()
  environmentScene.add(strips)
  let stripShape = ''
  const buildStrips = () => {
    const shape = `${params.stripCount},${params.stripWidth}`
    if (shape === stripShape) return
    stripShape = shape
    for (const strip of strips.children) (strip as THREE.Mesh).geometry.dispose()
    strips.clear()
    const middle = (STRIP_FROM + STRIP_TO) / 2
    const length = DISTANCE * (STRIP_TO - STRIP_FROM) // 仰角の範囲に渡る長さ
    const geometry = new THREE.PlaneGeometry(params.stripWidth, length)
    for (let k = 0; k < params.stripCount; k++) {
      const strip = new THREE.Mesh(geometry, stripMaterial)
      // 方位は半ピッチずらして、真正面 (+z) の方向に筋の隙間が来るようにする
      const azimuth = ((k + 0.5) / params.stripCount) * Math.PI * 2
      strip.position.setFromSphericalCoords(DISTANCE, Math.PI / 2 - middle, azimuth)
      strip.lookAt(0, 0, 0) // 長い辺が仰角の向き (上下) にそろう
      strips.add(strip)
    }
  }

  const keyMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const key = new THREE.Mesh(new THREE.CircleGeometry(1, 32), keyMaterial)
  environmentScene.add(key)

  const pmrem = new THREE.PMREMGenerator(renderer)
  let target: THREE.RenderTarget | undefined
  let lastSignature = ''
  const direction = new THREE.Vector3()

  // 毎フレーム呼ぶ。値が変わった時だけ作り直す
  function update() {
    const size = THREE.MathUtils.degToRad(Math.max(getLightSize(), 0.25))
    const signature = [
      light.position.x, light.position.y, light.position.z, light.intensity, light.color.getHex(), size, params.softbox, params.room,
      params.strips, params.stripCount, params.stripWidth,
    ].join(',')
    if (signature === lastSignature) return
    lastSignature = signature

    direction.copy(light.position).sub(light.target.position).normalize()
    key.position.copy(direction).multiplyScalar(DISTANCE)
    key.lookAt(0, 0, 0)
    const radius = Math.tan(size)
    key.scale.setScalar(DISTANCE * radius)
    keyMaterial.color.copy(light.color).multiplyScalar(light.intensity / (Math.PI * radius * radius))
    roomMaterial.color.setScalar(params.room)
    for (const { material, gain } of softboxes) material.color.setScalar(params.softbox * gain)
    buildStrips()
    stripMaterial.color.setScalar(params.strips)
    strips.visible = params.strips > 0
    target = pmrem.fromScene(environmentScene, 0.04, 0.1, 100, target ? { renderTarget: target } : {})
  }
  update()

  const folder = gui.addFolder('Studio')
  folder.add(params, 'softbox', 0, 10) // ソフトボックスの明るさ
  folder.add(params, 'room', 0, 0.3) // 部屋(壁)の明るさ
  folder.add(params, 'strips', 0, 10) // ストリップライトの明るさ (0で消える)
  folder.add(params, 'stripCount', 2, 16, 1) // 本数
  folder.add(params, 'stripWidth', 0.05, 1) // 幅 (距離8に置くので、0.3 で見かけの幅は約2°)

  return { texture: target!.texture, update }
}
