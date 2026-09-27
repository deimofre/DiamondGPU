import * as THREE from 'three/webgpu'
import {
  Fn, cameraPosition, float, log2, max, mix, normalize, positionView, positionWorld, pow, reflector, screenSize, screenUV,
  smoothstep, texture, uniform, vec2, vec3,
} from 'three/tsl'
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js'

// 床のラフネスマップ (細かい傷・汚れ。黒=つるつる、白=ざらざら)
const ROUGHNESS_MAP_URL = '/glass-roughness.webp'

// 背景と床 (ジュエリー撮影のスタジオのような見え方)
// - 背景: 画面中央が少し明るい放射状のグラデーション
// - 床: 黒い鏡面。遠くほど背景と同じ色に溶け込ませて、床の端(地平線)を見せない
const BLUR_TAPS = 16 // 映り込みをぼかすサンプル数
const GOLDEN_ANGLE = 2.39996
// floorLight: 床に届く光 (コースティクス)。映り込みに足す
export function createStage(scene: THREE.Scene, gui: GUI, floorLight: THREE.Node<'vec3'> = vec3(0)) {
  const bgCenter = uniform(new THREE.Color('#595e6e'))
  const bgEdge = uniform(new THREE.Color('#353555'))
  const bgSpread = uniform(0.8) // 中心からこの距離(画面の高さ基準)で外側の色になる

  // 背景と床の遠方の両方で使うので関数にしておく
  const backgroundColor = Fn(() => {
    const aspect = screenSize.x.div(screenSize.y)
    const dist = screenUV.sub(vec2(0.5, 0.55)).mul(vec2(aspect, 1)).length()
    return mix(bgCenter, bgEdge, smoothstep(0, bgSpread, dist))
  })
  scene.backgroundNode = backgroundColor()

  // reflector はカメラを床で鏡映しにした視点からシーンをもう一度描き、その画像を床に貼る。
  // 描画負荷が増えるので半分の解像度にしている
  const reflection = reflector({ resolutionScale: 0.5, generateMipmaps: true })
  reflection.target.rotateX(-Math.PI / 2)
  scene.add(reflection.target)

  const reflectivity = uniform(0.2) // 真上から見た時の映り込みの強さ。斜めから見るほど強くなる(フレネル)
  const roughness = uniform(0.04) // 床の粗さ = 映り込みをぼかす半径 (ワールド単位。0で完全な鏡)
  const fadeRadius = uniform(7) // 原点からこの距離で背景に溶け込む

  // ラフネスマップ: 白い部分(傷・汚れ)ほど粗くして映り込みをぼかす。
  // 床全体の粗さ(roughness)に「マップの値 × mapRoughness」を足す
  const roughnessMap = new THREE.TextureLoader().load(ROUGHNESS_MAP_URL)
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping
  roughnessMap.anisotropy = 8 // 床を斜めから見ても傷がぼやけて消えにくくする
  const mapRoughness = uniform(0.3) // マップが白の所で足す粗さ (ワールド単位)
  const mapScale = uniform(2) // マップ1枚を床の何ワールド単位分に貼るか (宝石1個の幅 ≈ 1)
  const floorRoughness = roughness.add(texture(roughnessMap, positionWorld.xz.div(mapScale)).g.mul(mapRoughness))

  // 映り込みのぼかし: 反射画像を渦巻き状(黄金角)に並べた点でサンプルして平均する。
  // 半径はワールド単位の粗さを、カメラからの距離で画面上の大きさに直す(遠い床ほど小さい)ので、
  // カメラが寄っても引いても床の粗さが一定に見える。サンプルの隙間はミップマップで埋める
  const blurredReflection = Fn(() => {
    const depth = max(positionView.z.negate(), 0.1)
    const radius = floorRoughness.div(depth).div(0.93) // 画面の高さに対する割合 (0.93 ≈ 2·tan(視野角50°/2))
    const aspect = screenSize.y.div(screenSize.x)
    const tapSpacing = radius.mul(screenSize.y).mul(0.5).mul(Math.sqrt(Math.PI / BLUR_TAPS)) // 反射画像(半分の解像度)でのサンプル間隔
    const level = log2(max(tapSpacing, 1))
    const center = screenUV.flipX()
    const sum = vec3(0).toVar()
    for (let k = 0; k < BLUR_TAPS; k++) {
      const r = Math.sqrt((k + 0.5) / BLUR_TAPS)
      const offset = vec2(Math.cos(k * GOLDEN_ANGLE) * r, Math.sin(k * GOLDEN_ANGLE) * r).mul(radius).mul(vec2(aspect, 1))
      sum.addAssign(reflection.sample(center.add(offset)).level(level).rgb)
    }
    return sum.div(BLUR_TAPS)
  })

  // フレネル: 真上から見ると映り込みは弱く、床すれすれの角度から見るほど強くなる
  const cosView = normalize(cameraPosition.sub(positionWorld)).y
  const fresnel = reflectivity.add(float(1).sub(reflectivity).mul(pow(float(1).sub(cosView), 5)))

  const floorMaterial = new THREE.MeshBasicNodeMaterial()
  const fade = smoothstep(fadeRadius, fadeRadius.mul(0.3), positionWorld.xz.length())
  // 映り込みあり・なしの2通り (コースティクスの光はどちらにも足す)。
  // なしの方は reflector を参照しないので、切り替えると鏡映しの描画(シーンをもう1回描く)も止まる
  const reflectiveFloor = mix(backgroundColor(), blurredReflection().mul(fresnel).add(floorLight), fade)
  const plainFloor = mix(backgroundColor(), floorLight, fade)
  let reflectionEnabled = true
  floorMaterial.colorNode = reflectiveFloor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMaterial)
  floor.rotation.x = -Math.PI / 2
  scene.add(floor)

  // lil-gui の色はsRGBの16進文字列で扱い、変更時に Color.set() で変換して入れる
  const params = { bgCenter: `#${bgCenter.value.getHexString()}`, bgEdge: `#${bgEdge.value.getHexString()}` }
  const folder = gui.addFolder('Stage')
  folder.addColor(params, 'bgCenter').onChange((value: string) => bgCenter.value.set(value))
  folder.addColor(params, 'bgEdge').onChange((value: string) => bgEdge.value.set(value))
  folder.add(bgSpread, 'value', 0.2, 2).name('bgSpread')
  folder.add(floor, 'visible').name('floor')
  folder.add(reflectivity, 'value', 0, 1).name('reflectivity')
  folder.add(roughness, 'value', 0, 0.2).name('roughness')
  folder.add(mapRoughness, 'value', 0, 1).name('mapRoughness')
  folder.add(mapScale, 'value', 0.5, 10).name('mapScale')
  folder.add(fadeRadius, 'value', 1, 20).name('fadeRadius')

  // 映り込みのオン・オフ (HUD から切り替える)。シェーダーを作り直すので、切り替えた瞬間だけ一瞬止まることがある
  function setReflection(value: boolean) {
    reflectionEnabled = value
    floorMaterial.colorNode = value ? reflectiveFloor : plainFloor
    floorMaterial.needsUpdate = true
  }

  return { reflection: () => reflectionEnabled, setReflection }
}
