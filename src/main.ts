import './style.css'
import * as THREE from 'three/webgpu'
import { pass, renderOutput, texture, uniform, vec3, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
import { GUI } from 'three/addons/libs/lil-gui.module.min.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createStage } from './stage'
import { createGemTracer, extractFacetPlanes } from './gemTracer'
import { createStarStreak } from './starStreak'
import { createCameraPath } from './cameraPath'
import { createCaustics } from './caustics'
import { createStudio } from './studio'
import type { GemPhysics } from './physics'
import { createLoader } from './loader'
import { createHud } from './hud'
import { NOTES } from './notes'
import { createGemPoke } from './poke'
import { createLens } from './lens'
import { quality } from './quality'
import { benchEnabled, createDebugOverlay, debugEnabled, type BenchStep } from './debug'
import { createFrameTiming } from './frameTiming'
import { createResolution } from './resolution'
import { createCrossfade } from './crossfade'
import { createTimeOfDay } from './timeOfDay'

// public/ に置いた GLB を読み込む (例: public/model.glb → '/model.glb')
const MODEL_URL = '/gem_drop_x8.glb'
// このマテリアル名(Blender側の名前)のメッシュを宝石マテリアルに置き換える
const GEM_MATERIAL_NAME = 'GemGlass'

const app = document.querySelector<HTMLDivElement>('#app')!

// --- 読み込み中の幕 (loader.ts) ---
// 最初の絵を出す条件がそろうまで幕で覆い、幕を上げ終わってから落とし始める。
// 条件: GPU の準備 / GLB / 物理 / 宝石を1回描き終えた (最初の描画はシェーダーの組み立てで時間がかかるので、それも幕の裏で済ませる)
const loader = createLoader(['gpu', 'model', 'physics', 'firstFrame'] as const)

// 物理 (physics.ts) は Rapier の wasm (約3MB) ごと別のファイルにして、最初の絵をそれで待たせない。
// 読み始めるのは起動直後 (GPU の準備・GLB・シェーダーの組み立てと並行して届くように)
const physicsModule = import('./physics')
physicsModule.catch((error) => loader.fail(error))

const scene = new THREE.Scene()

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100)
camera.position.set(3, 2, 4)

// WebGPURenderer: WebGPU非対応環境では自動でWebGL2にフォールバックする
const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
// 描画倍率 (resolution.ts)。PC は画面本来の解像度 (Retinaは2倍、普通のモニターは等倍)。
// スマホ・タブレットは描く画素の数の予算に収まる倍率にし、それでも重すぎる端末では自動で下げる (?bench の時は下げない)。
// 以前は等倍の画面でも2倍で描いていたが(ハイライトの縁のギザギザ対策)、描画ピクセル数が4倍になり重すぎたのでやめた
const resolution = createResolution(renderer, {
  auto: !benchEnabled,
  onChange: () => (display.pixelRatio = renderer.getPixelRatio()), // GUI の表示を合わせる
})
// 明るすぎる映り込みが真っ白に飛ばないよう圧縮する。ACES Filmic は暗部が締まり、宝石の色とハイライトが際立つ
// (Neutral・AgX と見比べてユーザーが選んだ。GUI の toneMapping で切り替えられる)
renderer.toneMapping = THREE.ACESFilmicToneMapping
// three.js の ACES は内部で露出を 1/0.6 (約1.67倍) にしているので、0.6 で打ち消して Neutral の頃に近い明るさにする。
// 1.0 のままだと全体が約35%明るくなり、背景の中間調とブルーム・光条が持ち上がってぎらついた (暗い中に光だけが浮かぶ方が品が良い)
renderer.toneMappingExposure = 0.6
try {
  await renderer.init()
} catch (error) {
  // WebGPU も WebGL2 も使えない端末 (読み込み直しても変わらないので、押しても何もしない)
  loader.fail(error, 'WebGPU / WebGL2 is not available', false)
  throw error
}
loader.complete('gpu')
app.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
// カメラが床(y=0)すれすれまで下がらないようにする。真横(0°)からだと床が線になり映り込みも消えるので、
// 注視点を見下ろす角度(仰角)に下限を設ける。回転はこの角度までに制限する
// (パンで注視点が床より下に行く場合は、アニメーションループでカメラごと持ち上げる)
const MIN_ELEVATION = THREE.MathUtils.degToRad(2)
controls.maxPolarAngle = Math.PI / 2 - MIN_ELEVATION
// 近づける・遠ざけられる限度 (注視点からの距離)。遠い方は自動カメラの一番遠いキー (真上寄り、約11) より少し先まで。
// 手動に切り替えた瞬間にカメラが引き戻されないようにするため。近い方は注視点に潰れ込まない程度 (宝石への接写はできる)
controls.minDistance = 1
controls.maxDistance = 14
// パンで注視点を動かせる範囲 (宝石の群れを見失わないように。アニメーションループで収める)
const PAN_RADIUS = 4 // 原点からの水平距離
const PAN_HEIGHT = 2 // 床からの高さ

scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.5))
const dir = new THREE.DirectionalLight(0xffffff, 2)
// キーライト。夜は高さ(仰角)18°、方位59°(+x と +z の間)から照らす。朝・昼・夕方は時刻で少しずれる (timeOfDay.ts)。
// 夜の向きは GUI の Time の light elevation / light azimuth で動かせる
dir.position.setFromSphericalCoords(10, THREE.MathUtils.degToRad(90 - 18), THREE.MathUtils.degToRad(59))
scene.add(dir)
// コースティクス (caustics.ts)。この平行光源が宝石を通って床に落とす光の模様
const caustics = createCaustics(renderer, dir)

const gui = new GUI()

// --- ポストプロセス (TSLノードベース, r183+では PostProcessing 改め RenderPipeline) ---
const pipeline = new THREE.RenderPipeline(renderer)
const scenePass = pass(scene, camera)
const scenePassColor = scenePass.getTextureNode('output')
const viewZ = scenePass.getViewZNode()

// DoF: focusDistance = ピント位置(ワールド単位), focalLength = 完全にボケるまでの距離, bokehScale = ボケの大きさ
// ピント位置から少しでも外れた部分には半分解像度のボケ画像が混ざるため、
// focalLength が小さいと散らばった宝石の大半が甘くなる。宝石の散らばり(±2程度)に合わせて広めにしている
const focusDistance = uniform(5.0)
const focalLength = uniform(5.0)
// ピントの外はしっかりぼかす (ユーザーの指定。以前は3)。ボケの大きさは描いている画像の画素が単位なので、
// 動いている間 (描画倍率が低い) は倍率の比を掛け、止まっている間と同じ見かけの大きさにする (アニメーションループ)
const bokeh = { scale: 6 }
const bokehScale = uniform(bokeh.scale)
// as: @types/three 0.185ではdof()/bloom()の戻り型がTempNode(ジェネリクス未指定)のままで
// fluent APIを持つNode<'vec4'>になっていないため、アサーションで補正する
const dofNode = dof(scenePassColor, viewZ, focusDistance, focalLength, bokehScale)
const dofPass = dofNode as unknown as THREE.Node<'vec4'>
if (quality.dofScale !== 0.5) setBokehResolution(dofNode, quality.dofScale)
// レンズとフィルムの仕上げ (lens.ts)。ボケの形 (絞り羽根) は DoF の中のサンプルの並びを差し替える
const lens = createLens(gui)
lens.shapeBokeh(dofNode)

// ブルームと光条は、ボケを掛けた後の画像から強いハイライトを拾う (光条は周囲のピクセルも読むのでテクスチャで渡す)。
// DoF を切った時は、この入力をボケを掛ける前の画像に差し替える
// (as: getTextureNode() は実装にあるが @types/three 0.185 の型定義に無いため)
const dofTexture = (dofNode as unknown as { getTextureNode(): THREE.TextureNode }).getTextureNode().value
const effectInput = texture(dofTexture)
// threshold は明るさを圧縮する前の値で判定する。低いと映り込み全体が光ってギラつくので、強いハイライトだけにかける
const bloomNode = bloom(effectInput, 0.2, 0.4, 1.5) // strength, radius, threshold
const starNode = createStarStreak(effectInput, gui) // 光条 (starStreak.ts)
const effects = (bloomNode as unknown as THREE.Node<'vec4'>).add(vec4(starNode, 0))

// トーンマッピングは RenderPipeline に任せず自分でつなぐ (フィルムの粒子をその後に足すため)
pipeline.outputColorTransform = false

// DoF のオン・オフ (HUD から切り替える)。切ると DoF がつなぎ方から外れて、その計算も止まる
// (ブルーム・光条より先に DoF が描かれるよう、DoF を式の先頭に置く)
let dofEnabled = true
let glowEnabled = true // ブルームと光条 (HUD の Glow で切り替える。?bench の負荷の内訳でも外して測る)
function buildOutput() {
  effectInput.value = dofEnabled ? dofTexture : scenePassColor.value
  const base: THREE.Node<'vec4'> = dofEnabled ? dofPass : scenePassColor
  // シャープ・色収差 → ブルームと光条を足す → 周辺減光 → トーンマッピング → フィルムの粒子
  const optics = lens.optics(base, effectInput)
  const hdr = lens.darkenEdges(glowEnabled ? optics.add(effects) : optics)
  pipeline.outputNode = lens.addGrain(renderOutput(hdr))
  pipeline.needsUpdate = true
}
function setDof(value: boolean) {
  dofEnabled = value
  buildOutput()
}
function setGlow(value: boolean) {
  glowEnabled = value
  buildOutput()
}
buildOutput()

// DoF のボケを計算する解像度を変える (DepthOfFieldNode は半分で固定なので、setSize を差し替える)。
// サンプルの間隔 (_invSize) は元の画像の画素のままなので、ボケの大きさは変わらず、ボケの画像が粗くなるだけ。
// 中身は DepthOfFieldNode.setSize (three r185) の写しで、ボケをぼかす4枚の画像の大きさだけが違う
// (元の setSize を呼んでから直すと、毎フレーム大きさが2回変わって画像を作り直してしまうため、丸ごと置き換える)
type DofInternals = {
  setSize(width: number, height: number): void
  _invSize: { value: THREE.Vector2 }
  _CoCRT: THREE.RenderTarget
  _compositeRT: THREE.RenderTarget
  _CoCBlurredRT: THREE.RenderTarget
  _blur64RT: THREE.RenderTarget
  _blur16NearRT: THREE.RenderTarget
  _blur16FarRT: THREE.RenderTarget
}
function setBokehResolution(dofNode: unknown, scale: number) {
  const node = dofNode as DofInternals
  node.setSize = (width, height) => {
    node._invSize.value.set(1 / width, 1 / height)
    node._CoCRT.setSize(width, height)
    node._compositeRT.setSize(width, height)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    for (const target of [node._CoCBlurredRT, node._blur64RT, node._blur16NearRT, node._blur16FarRT]) target.setSize(w, h)
  }
}

// --- GUI ---
const dofFolder = gui.addFolder('DoF')
// autofocus の間はピントを毎フレーム自動で合わせる (下の updateFocus)。GUI の表示も追従させ、手では動かせないようにする
const focusParams = { autofocus: true }
const autofocusController = dofFolder.add(focusParams, 'autofocus')
const focusController = dofFolder.add(focusDistance, 'value', 0.1, 20).name('focusDistance').listen().disable()
autofocusController.onChange((value: boolean) => focusController.enable(!value))
dofFolder.add(focalLength, 'value', 0.1, 10).name('focalLength')
dofFolder.add(bokeh, 'scale', 0, 10).name('bokehScale') // 止まっている間の描画倍率での大きさ
const bloomFolder = gui.addFolder('Bloom')
bloomFolder.add(bloomNode.strength, 'value', 0, 2).name('strength')
bloomFolder.add(bloomNode.radius, 'value', 0, 1).name('radius')
bloomFolder.add(bloomNode.threshold, 'value', 0, 5).name('threshold')
// トーンマッピング (明るさの幅を画面に収める変換)。切り替えると RenderPipeline が出力のシェーダーを作り直す
// - Neutral: 色味と明るさを変えにくい (製品写真向き)
// - AgX: 明るい所ほど色が抜けて白に溶けていく、映画的な階調
// - ACES Filmic: コントラストが強く、暗部が締まる
gui.add(renderer, 'toneMapping', { Neutral: THREE.NeutralToneMapping, AgX: THREE.AgXToneMapping, 'ACES Filmic': THREE.ACESFilmicToneMapping })
gui.add(renderer, 'toneMappingExposure', 0, 3).name('exposure')
gui.add(scene, 'environmentIntensity', 0, 3).name('envIntensity')
const stage = createStage(scene, gui, caustics.floorLight)
// --- 環境マップ (studio.ts) ---
// 宝石やガラスは周囲を映し・透かして見えるので、何もない空間だと質感が出ない。
// 暗い撮影スタジオに照明を数灯置いた環境を作り、映り込みと宝石の中を通る光に使う (画面の背景は stage.ts のまま)
const studio = createStudio(renderer, dir, caustics.lightSize, gui)
scene.environment = studio.texture
// --- 時刻による光の移ろい (timeOfDay.ts) ---
// 見る人の端末の時刻で、キーライトの色と向き・スタジオの窓・背景の色味を少しだけ変える (夜は上の設定のまま)
const timeOfDay = createTimeOfDay(dir, { setWindow: studio.setWindow, setBackgroundTint: stage.setBackgroundTint }, gui)
// 画質と負荷の比較用 (2倍で描画ピクセル数は等倍の4倍)
const display = { pixelRatio: renderer.getPixelRatio(), fps: quality.fps }
gui.add(display, 'pixelRatio', 0.5, 3, 0.25).listen().onChange((value: number) => resolution.set(value)) // 動かすと自動調整は止まる
gui.add(display, 'fps', [60, 30]).name('fps limit') // 動いている間に描く回数の上限

// --- 宝石マテリアル ---
// GLBのマテリアルはローダーが MeshPhysicalMaterial として作る。TSLノードを差し込めるよう
// MeshPhysicalNodeMaterial に置き換える (色・IOR・ラフネス・透過・両面はGLBの値を引き継ぐ)。
// GUIはマテリアルのプロパティに直接繋ぐ。プロパティは描画のたびに参照されるので、変えるとすぐ反映される。
// clearcoat や iridescence などは0の間はシェーダーから処理ごと外れていて、0から動かした時だけ
// レンダラーが自動でシェーダーを作り直す (その瞬間だけ一瞬止まることがある)。
// TSLノードは、プロパティでは表せない「宝石ごとの色」と内部反射シェーダーに使っている
// 宝石ごとの初期色 (内部を attenuationDistance 進んだ光に付く色)。個数が多ければ先頭から繰り返す。白にすると無色透明。
// 色石は一番明るい成分をリニアで0.7に抑えてある。1.0の成分は全く吸収されないので、長く通っても明るさが落ちず
// 鮮やかになるだけになる。1.0未満にしておくと、厚い所(光が長く通った所)ほど色が濃く暗くなる
const GEM_COLORS = [
  '#ffffff', // ダイヤ
  '#da2240', // ルビー
  '#224dda', // サファイア
  '#1fd17a', // エメラルド (元から一番明るい成分が約0.64)
  '#8d40da', // アメジスト
  '#da9814', // トパーズ
  '#50c2da', // アクアマリン
  '#da679d', // ピンク
]

// 分散(ファイア)の強さは宝石ごとに変える。GEM_COLORS の先頭 (ダイヤ) はマテリアルの dispersion のまま、
// 色石はその STONE_FIRE 倍。実物の分散はルビー・サファイアで約0.018、エメラルド等で約0.014 と、ダイヤ (0.044) の半分以下
// (全部同じだと色石の虹色が強すぎて、ガラス玉のように見えた)
const STONE_FIRE = 0.4

const REFLECTION_BOUNCES = 2 // 床の映り込みの中の宝石の反射回数

function applyGemMaterial(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && (mesh.material as THREE.Material).name === GEM_MATERIAL_NAME) meshes.push(mesh)
  })
  if (meshes.length === 0) return meshes
  const src = meshes[0].material as THREE.MeshPhysicalMaterial

  const mat = new THREE.MeshPhysicalNodeMaterial({
    name: GEM_MATERIAL_NAME,
    color: src.color,
    roughness: src.roughness,
    metalness: 0,
    ior: src.ior,
    transmission: src.transmission,
    side: src.side,
    thickness: 0.5, // 屈折・吸収の計算に使う内部の厚み (宝石1個の幅 ≈ 1)
    // この距離を進むと宝石の色になる (小さいほど色が濃い)。光が中を進んだ距離に応じて色が付くので、
    // 薄い縁を抜けた光は淡く、中で何度も反射した光ほど濃くなる。宝石の中の光の道のりは 0.3〜4 程度なので、
    // その真ん中あたりにしておくと濃淡の差が出る (1 だとほとんどの光が飽和して単色の色ガラスのように見えた)
    attenuationDistance: 2.5,
    // 光が虹色に分かれる強さ(ファイア)。実物のダイヤは約0.36 (=20/アッベ数55)、見栄え重視で強めにしている
    dispersion: 3,
    sheenColor: 0xffffff, // three.js の初期値は黒で、sheen を上げても何も起きないため
  })

  // 宝石ごとの色。マテリアルは1つを共有したまま、描画するオブジェクトごとに
  // userData.gemColor を uniform に流し込む (マテリアルを分けないのでシェーダーも1つで済む)
  const gemColor = uniform(new THREE.Color()).onObjectUpdate(({ object }) => object?.userData.gemColor)
  const glow = uniform(0) // 宝石ごとの色で自己発光させる強さ (ブルームと組み合わせると光って見える)
  const fireScale = uniform(1).onObjectUpdate(({ object }) => object?.userData.fireScale ?? 1) // 宝石ごとの分散の倍率
  const glowEmissive = gemColor.mul(glow)
  mat.attenuationColorNode = gemColor

  // 内部反射シェーダー (gemTracer.ts)。中で反射させる最大回数が多いほど正確だが重い
  const bounces = uniform(5, 'int')
  // 床の映り込み (reflector が鏡映しのカメラでもう一度描く) の中の宝石は、ぼかして薄く見せるだけなので反射回数を減らして軽くする。
  // onObjectUpdate の値は「オブジェクトと描画先の組」ごとに別々に持てるので、描いているカメラで回数を切り替えられる
  // (コースティクスの計算は GUI の bounces をそのまま使う)
  const tracerBounces = uniform(5, 'int').onObjectUpdate(({ camera: current }) =>
    current === camera ? bounces.value : Math.min(bounces.value, REFLECTION_BOUNCES),
  )
  const planes = extractFacetPlanes(meshes[0].geometry)
  const traced = createGemTracer({
    planes,
    envMap: scene.environment as THREE.Texture,
    envIntensity: uniform(1).onRenderUpdate(() => scene.environmentIntensity),
    gemColor,
    bounces: tracerBounces,
    fireScale,
  })

  // lil-gui の色はsRGBの16進文字列で扱い、変更時に Color.set() で変換して入れる
  const hex = (color: THREE.Color) => `#${color.getHexString()}`
  const params = { color: hex(mat.color), specularColor: hex(mat.specularColor), sheenColor: hex(mat.sheenColor) }
  const gemFolder = gui.addFolder('Gem')

  // 描き方の切り替え
  // - internal reflection: 内部反射シェーダー。表面の反射はこのマテリアルの鏡面反射に任せ、
  //   中を通って出てくる光を自己発光として足す (拡散色と標準の透過は切る)
  // - standard transmission: three.js 標準の透過 (1回屈折させて画面の背景を覗く)
  const render = { mode: 'trace' }
  const standardOnly: { enable(enabled?: boolean): unknown }[] = []
  const traceOnly: { enable(enabled?: boolean): unknown }[] = []
  let saved = { transmission: mat.transmission, side: mat.side }
  const applyMode = () => {
    const trace = render.mode === 'trace'
    if (trace) {
      saved = { transmission: mat.transmission, side: mat.side }
      mat.transmission = 0
      mat.side = THREE.FrontSide // 裏面は光線追跡で扱うので表面だけ描く
    } else {
      mat.transmission = saved.transmission
      mat.side = saved.side
    }
    mat.colorNode = trace ? vec3(0) : null
    mat.emissiveNode = trace ? traced.add(glowEmissive) : glowEmissive
    mat.needsUpdate = true
    for (const controller of standardOnly) controller.enable(!trace)
    for (const controller of traceOnly) controller.enable(trace)
    for (const controller of gemFolder.controllersRecursive()) controller.updateDisplay()
  }
  gemFolder.add(render, 'mode', { 'internal reflection': 'trace', 'standard transmission': 'standard' }).onChange(applyMode)
  traceOnly.push(gemFolder.add(bounces, 'value', 1, 12, 1).name('bounces'))

  const surface = gemFolder.addFolder('Surface')
  surface.addColor(params, 'color').onChange((value: string) => mat.color.set(value))
  surface.add(mat, 'roughness', 0, 1)
  surface.add(mat, 'metalness', 0, 1)
  surface.add(mat, 'ior', 1, 3)
  surface.add(mat, 'specularIntensity', 0, 1) // 表面反射の強さ
  surface.addColor(params, 'specularColor').onChange((value: string) => mat.specularColor.set(value))
  // Double は裏面→表面の2回描画になる (カットの内側の面も見える)
  standardOnly.push(surface.add(mat, 'side', { Front: THREE.FrontSide, Back: THREE.BackSide, Double: THREE.DoubleSide }))

  const transmission = gemFolder.addFolder('Transmission')
  standardOnly.push(transmission.add(mat, 'transmission', 0, 1))
  standardOnly.push(transmission.add(mat, 'thickness', 0, 3))
  transmission.add(mat, 'attenuationDistance', 0.05, 5)
  transmission.add(mat, 'dispersion', 0, 10) // ダイヤの分散。色石はこの stoneFire 倍
  const fire = { stoneFire: STONE_FIRE }
  const isDiamond = (i: number) => i % GEM_COLORS.length === 0
  transmission.add(fire, 'stoneFire', 0, 1).onChange((value: number) => {
    meshes.forEach((mesh, i) => (mesh.userData.fireScale = isDiamond(i) ? 1 : value))
  })

  // 以下は初期値0 (無効)。使う時に開く
  const clearcoat = gemFolder.addFolder('Clearcoat').close() // 表面に重ねる透明なコーティング層
  clearcoat.add(mat, 'clearcoat', 0, 1)
  clearcoat.add(mat, 'clearcoatRoughness', 0, 1)

  const iridescence = gemFolder.addFolder('Iridescence').close() // 表面の薄膜の虹色 (シャボン玉・オイル膜)
  iridescence.add(mat, 'iridescence', 0, 1)
  iridescence.add(mat, 'iridescenceIOR', 1, 2.333)
  // 膜の厚み(nm)で出る色が変わる。テクスチャなしの場合は範囲の最大値が使われる
  iridescence.add(mat.iridescenceThicknessRange, '1', 100, 1000).name('thickness (nm)')

  const sheen = gemFolder.addFolder('Sheen').close() // 布のような縁の光沢
  sheen.add(mat, 'sheen', 0, 1)
  sheen.add(mat, 'sheenRoughness', 0, 1)
  sheen.addColor(params, 'sheenColor').onChange((value: string) => mat.sheenColor.set(value))

  gemFolder.add(glow, 'value', 0, 5).name('glow')

  // 色はメッシュ名(Blenderのオブジェクト名)ごとにGUIで変えられる
  const colorFolder = gemFolder.addFolder('Colors')
  const colors: Record<string, string> = {}
  meshes.forEach((mesh, i) => {
    mesh.material = mat
    colors[mesh.name] = GEM_COLORS[i % GEM_COLORS.length]
    mesh.userData.gemColor = new THREE.Color(colors[mesh.name])
    mesh.userData.fireScale = isDiamond(i) ? 1 : fire.stoneFire
    colorFolder.addColor(colors, mesh.name).onChange((hex: string) => mesh.userData.gemColor.set(hex))
  })

  applyMode()
  caustics.setGems({ gems: meshes, planes, material: mat, bounces }, gui)
  return meshes
}

// --- 落下 (physics.ts) ---
// GLB の宝石は最初の姿勢(空中)で置いてあり、そこから物理シミュレーションで落とす。
// 幕が上がったらすぐ1回落とし、その後は start ボタンで何度でもやり直せる (一番下)
// (Clockはr183で非推奨になったのでTimerを使う)
let physics: GemPhysics | undefined
// 読み込めた物理は、幕が上がるまで physics に入れずに取っておく (幕の裏で Space キーの start が効かないように)
let preparedPhysics: GemPhysics | undefined
const timer = new THREE.Timer()
timer.connect(document) // タブ非表示中は時間を進めない
const gems: THREE.Mesh[] = []

// --- カメラワーク (cameraPath.ts) ---
// autoCamera の間は落とし始めてからの時間に合わせてカメラが動き、ピントは宝石群の中心を追う(ピント送り)。
// 画面をドラッグすると手動操作に切り替わる
const cameraPath = createCameraPath()
const playback = { speed: 1, autoCamera: true }
const animationFolder = gui.addFolder('Animation') // start と autoCamera は HUD にある
animationFolder.add(playback, 'speed', 0, 2) // 0.2 などにするとスローモーション
// 手動操作への切り替え (autoCamera を切る) は、ドラッグ・2本指・ホイールの時だけ。宝石のタップでは切らない (下の createGemPoke)

// --- HUD (hud.ts) ---
// 見る人が触る項目は画面下の HUD に置き、作品の一部として見せる。
// 調整用の lil-gui は見た目の邪魔にならないよう普段は隠し、G キーで出し入れする (?debug の時は最初から出す)
let tuningVisible = debugEnabled
gui.show(tuningVisible)
if (debugEnabled) gui.close() // スマホでは開くと画面の大半を覆うので、畳んだ状態で出す
const hud = createHud({
  toggles: [
    { label: 'DoF', detail: 'Depth of field', get: () => dofEnabled, set: setDof },
    { label: 'Reflection', detail: 'Floor mirror', get: stage.reflection, set: stage.setReflection },
    { label: 'Glow', detail: 'Bloom + streak', get: () => glowEnabled, set: setGlow },
    { label: 'Caustics', detail: 'Traced light', get: caustics.isEnabled, set: caustics.setEnabled, available: caustics.supported },
  ],
  camera: { label: 'Auto camera', get: () => playback.autoCamera, set: (value) => (playback.autoCamera = value) }, // 右上に離して置く
  notes: NOTES, // 技術ノート (右上の (i)。文章は notes.ts)
  start: () => physics?.start(), // 最初の姿勢に戻して落とす (何度でもやり直せる)
  changed: () => invalidate(),
  status: () => physics && { running: physics.running, settled: physics.settled },
  ready: loader.ready, // 幕が上がり始めたら登場する
  clock: () => timeOfDay.display, // 左上の時刻と時間帯の印
  shortcuts: [
    {
      key: 'g',
      label: 'Tuning',
      action: () => {
        tuningVisible = !tuningVisible
        gui.show(tuningVisible)
      },
    },
  ],
})

new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    scene.add(gltf.scene)
    gems.push(...applyGemMaterial(gltf.scene))
    // モデル全体が収まるようにカメラの距離を決める (自動カメラの間は毎フレーム上書きされる)
    const box = new THREE.Box3().setFromObject(gltf.scene)
    // 物理で位置と向きを直接書き換えるので、宝石をシーン直下に移す (見た目の位置は変わらない)
    for (const gem of gems) scene.attach(gem)
    loader.complete('model')
    physicsModule
      .then(({ createGemPhysics }) => {
        preparedPhysics = createGemPhysics(gems)
        loader.complete('physics')
      })
      .catch((error) => loader.fail(error))

    // 注視点(カメラが見る点・ドラッグで回す中心)は原点。DoFのピントも原点に合わせる
    const size = box.getSize(new THREE.Vector3()).length()
    controls.target.set(0, 0, 0)
    camera.position.set(size, size * 0.6, size)
    focusDistance.value = camera.position.length()
    focusController.updateDisplay()
  },
  undefined,
  (error) => loader.fail(new Error(`${MODEL_URL} を読み込めませんでした。GLBを web/public/ に置いてください。`, { cause: error })),
)

// --- 宝石を突く (poke.ts) ---
// タップした宝石を、見る人から遠ざかる向き (視線の水平成分) へ押しつつ上へ弾く。縁を突くほど回る
const POKE_UP = 3.5 // 上向きの速度 (m/s)。約0.6 の高さまで跳ぶ
const POKE_PUSH = 1.5 // 奥へ押す速度 (m/s)
const poke = { strength: 1, spin: 0.35 }
const pokeFolder = gui.addFolder('Poke')
pokeFolder.add(poke, 'strength', 0, 3)
pokeFolder.add(poke, 'spin', 0, 1) // 突いた位置どおりの回転を1として、どれだけかけるか
const pokeVelocity = new THREE.Vector3()
createGemPoke({
  element: renderer.domElement,
  camera,
  targets: () => gems,
  onPoke: (hit, ray, event) => {
    if (!physics) return
    pokeVelocity.set(ray.direction.x, 0, ray.direction.z).normalize().multiplyScalar(POKE_PUSH)
    pokeVelocity.y = POKE_UP
    physics.poke(hit.object, hit.point, pokeVelocity.multiplyScalar(poke.strength), poke.spin)
    hud.ripple(event.clientX, event.clientY)
  },
  onCameraInput: () => (playback.autoCamera = false),
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  resolution.fit() // スマホは画面の大きさで倍率が変わる (向きを変えた時など)
  invalidate()
})

// --- 描画の省略 ---
// 描き直すのは、前に描いた時から画面上で見て分かる変化があった時 (visibleChange) と、invalidate() が呼ばれた時だけ:
// GUI の値の変更・HUD の操作・画面サイズの変更・ファイルの読み込み完了 (床のラフネスマップなど、後から届く物)
let needsRender = true
function invalidate() {
  needsRender = true
}
gui.onChange(invalidate)
THREE.DefaultLoadingManager.onProgress = invalidate

// 以前は位置が少しでも変われば描き直していた。そのため、指を離した後のカメラの慣性 (目に見えない細かさの動きが約10秒続く。
// 0.5px 以上動くのは最初の約0.5秒だけ) や、止まりかけの宝石の細かい揺れの間も、ずっと全部を描き直していた (スマホが熱を持った)。
// 今は前に描いた時の位置・向き・ピントと比べ、画面上の動きが VISIBLE_SHIFT に満たなければ描かない。
// 比べる相手は「前に描いた時」なので、ゆっくりした動きも積み重なれば描かれる (取り残されない)
const VISIBLE_SHIFT = 0.5 // 描き直す動きの大きさ (動いている間の描画倍率での画素。resolution.ts)
const FOCUS_SHIFT = 0.004 // ピントの移動が focalLength のこの割合を超えたら描き直す (ピントの内と外の混ぜ具合が約1%変わる)
type Pose = { position: THREE.Vector3; quaternion: THREE.Quaternion }
const renderedPoses = new Map<THREE.Object3D, Pose>()
let renderedFocus = focusDistance.value

// 前に描いた時から、見て分かる変化があったか
function visibleChange() {
  if (Math.abs(focusDistance.value - renderedFocus) > FOCUS_SHIFT * focalLength.value) return true
  // 画面の中央で VISIBLE_SHIFT 画素に当たる角度 (ラジアン)。画素は動いている間の倍率で数える
  // (止まってくっきり描いた後に判定が細かくならないように)
  const bufferHeight = innerHeight * resolution.motionRatio()
  const minAngle = (VISIBLE_SHIFT / bufferHeight) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  // 動いた長さ (ワールド単位) を、その距離から見た角度に直して比べる
  const shifted = (object: THREE.Object3D, radius: number, distance: number) => {
    const pose = renderedPoses.get(object)
    if (!pose) return true
    const shift = object.position.distanceTo(pose.position) + object.quaternion.angleTo(pose.quaternion) * radius
    return shift / distance > minAngle
  }
  // カメラ: 向きが変わると画面全体が同じ角度だけずれる。位置が変わると近い物ほど大きくずれるので、一番近い宝石で測る
  let nearest = camera.position.distanceTo(controls.target)
  for (const gem of gems) nearest = Math.min(nearest, gem.position.distanceTo(camera.position))
  const cameraPose = renderedPoses.get(camera)
  if (!cameraPose || camera.quaternion.angleTo(cameraPose.quaternion) + camera.position.distanceTo(cameraPose.position) / nearest > minAngle) return true
  // 宝石: 中心の移動と、回転で縁が動く長さ
  return gems.some((gem) => shifted(gem, (gem.geometry.boundingSphere?.radius ?? 1) * gem.scale.x, gem.position.distanceTo(camera.position)))
}

// 描いた時の位置・向き・ピントを覚えておく (次の visibleChange の比べる相手)
function rememberRendered() {
  for (const object of [camera, ...gems]) {
    const pose = renderedPoses.get(object) ?? { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
    pose.position.copy(object.position)
    pose.quaternion.copy(object.quaternion)
    renderedPoses.set(object, pose)
  }
  renderedFocus = focusDistance.value
}

// --- ピント (DoF) ---
// 自動カメラの間も手動操作 (ドラッグ・ホイール) の間も、ピントを宝石に合わせ続ける (カメラのオートフォーカスと同じ考え方)。
// 1. 画面の中央に十字に並べた5つの測距点から光線を飛ばし、宝石に当たったうち一番手前に合わせる
//    (1点だと宝石の輪郭にかかった時に当たり外れが入れ替わってピントがふらつくので、少し広げている)
// 2. どれも当たらない時 (中央が宝石の隙間) は、画面の中央に近い宝石ほど重く見た平均に合わせる
// 奥行きは「視線方向の深度」(DoF はカメラからの直線距離ではなくこれで判定する)。
// ピントはレンズのように少し遅れて追いかける (合わせる相手が切り替わる時に急に跳ばない)
const FOCUS_POINTS = [[0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]] // 測距点 (画面の高さの半分 = 1)
const FOCUS_SPREAD = 0.35 // 2 の重み: 画面の中央からこの距離離れた宝石の重みは約6割
const FOCUS_FLOOR = 1e-3 // 2 で全部が中央から遠い時も宝石群全体の平均になるよう、全員に最低限の重みを持たせる
const FOCUS_SPEED = 6 // ピントが追いかける速さ (1/秒)。大きいほど速く合う
const focusRaycaster = new THREE.Raycaster()
const focusPoint = new THREE.Vector2()
const gemPosition = new THREE.Vector3()
const panCorrection = new THREE.Vector3()
const viewDirection = new THREE.Vector3()
const projected = new THREE.Vector3()

// 測距点で宝石に当たった一番手前の深度 (当たらなければ undefined)
function measureFocus() {
  let nearest: number | undefined
  for (const [x, y] of FOCUS_POINTS) {
    focusPoint.set(x / camera.aspect, y) // 横方向も高さ基準の距離にそろえる
    focusRaycaster.setFromCamera(focusPoint, camera)
    const hit = focusRaycaster.intersectObjects(gems, false)[0]
    if (!hit) continue
    const depth = projected.subVectors(hit.point, camera.position).dot(viewDirection)
    nearest = Math.min(nearest ?? depth, depth)
  }
  return nearest
}

function updateFocus(delta: number) {
  camera.getWorldDirection(viewDirection) // カメラの行列もここで更新される (下の光線と project で使う)
  const target = measureFocus() ?? averageFocus()
  if (target === undefined) return
  const current = focusDistance.value
  const next = current + (target - current) * (1 - Math.exp(-FOCUS_SPEED * delta))
  // ピントが動いている間は、カメラと宝石が止まっていても描き直す (見て分かるほど動いたかは visibleChange で判断する)
  focusDistance.value = next
}

// 画面の中央に近い宝石ほど重く見た、宝石の深度の平均
function averageFocus() {
  let weighted = 0
  let total = 0
  for (const gem of gems) {
    gem.getWorldPosition(gemPosition)
    const depth = projected.subVectors(gemPosition, camera.position).dot(viewDirection)
    if (depth <= camera.near) continue // カメラの後ろ
    projected.copy(gemPosition).project(camera)
    const offCenter = Math.hypot(projected.x * camera.aspect, projected.y)
    const weight = Math.exp(-(offCenter * offCenter) / (2 * FOCUS_SPREAD * FOCUS_SPREAD)) + FOCUS_FLOOR
    weighted += depth * weight
    total += weight
  }
  return total > 0 ? weighted / total : undefined
}

// 120Hz の画面でも 60fps で回す (動いている間の GPU の仕事量を半分にする。上限は quality.ts と GUI の fps limit)。
// 間隔の揺れで1コマおきに落ちないよう1ms手前から許し、超えた分は次の間隔に持ち越す
let lastFrame = 0
const STILL_DELAY = 300 // 動きが止まってから、くっきり描き直すまで (ms。ゆっくり動かしている間に切り替わらないように)
let lastMotion = 0 // 最後に動いていた時刻
// くっきり描き直す時に、直前の軽い絵から溶かすように切り替える (crossfade.ts)
const crossfade = createCrossfade(renderer.domElement, app, debugEnabled)
const timing = createFrameTiming(renderer) // 描いたコマの CPU・GPU の時間 (描画倍率の自動調整と確認用の表示が読む)
const debugOverlay = createDebugOverlay(renderer, timing, () => [resolution.describe(), crossfade.result].filter(Boolean).join(' '))

// --- 負荷の内訳 (?bench。debug.ts) ---
// 落下が終わってカメラも止まったら (自動カメラは落とし始めてから10秒で止まる)、効果を1つずつ外して GPU の時間を測る。
// 外すのは1項目ずつで、測り終えたら元に戻す (差がそのままその効果の重さになる)。
// -gems は宝石の描画 (内部反射シェーダー。床の映り込みの中の分も含む) を外す。コースティクスの計算は残る
const BENCH_START = 10.5 // 落とし始めてからの秒数
let benchStarted = false
const offStep = (label: string, get: () => boolean, set: (value: boolean) => void): BenchStep => {
  let before = false
  return {
    label,
    apply: () => {
      before = get()
      set(false)
    },
    revert: () => set(before),
  }
}
const baseline: BenchStep = { label: 'all on', apply() {}, revert() {} }
const benchSteps: BenchStep[] = [
  baseline,
  offStep('-caustics', caustics.isEnabled, caustics.setEnabled),
  offStep('-reflection', stage.reflection, stage.setReflection),
  offStep('-DoF', () => dofEnabled, setDof),
  offStep('-bloom/star', () => glowEnabled, setGlow),
  offStep('-gems', () => gems[0]?.visible ?? false, (value) => gems.forEach((gem) => (gem.visible = value))),
  // 描画倍率を 0.75 倍にした時 (描く画素の数は約56%)。解像度がどれだけ効くかを見る
  { label: 'res ×0.75', apply: () => renderer.setPixelRatio(display.pixelRatio * 0.75), revert: () => renderer.setPixelRatio(display.pixelRatio) },
  { ...baseline }, // 最後にもう一度 (最初と比べて、熱で遅くなっていないかを見る)
]

renderer.setAnimationLoop((timestamp) => {
  const interval = 1000 / display.fps
  const elapsed = timestamp - lastFrame
  if (elapsed < interval - 1) return
  lastFrame = timestamp - (elapsed >= interval ? elapsed % interval : 0)
  const frameStart = performance.now()

  timer.update(timestamp)
  const delta = timer.getDelta()
  physics?.update(delta * playback.speed)
  if (benchEnabled && !benchStarted && physics && physics.time > BENCH_START) {
    benchStarted = true
    debugOverlay.runBench(benchSteps)
  }
  if (playback.autoCamera) {
    cameraPath(physics?.time ?? 0, camera.position)
    // キーフレームを変えても床すれすれまで下がらないように (手動操作と同じ仰角の下限)
    const horizontal = Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z)
    camera.position.y = Math.max(camera.position.y, controls.target.y + horizontal * Math.tan(MIN_ELEVATION))
    camera.lookAt(controls.target)
  } else {
    controls.update()
    // パンで注視点が範囲の外に出たら、カメラごと範囲の中へ戻す (見え方は変えずに平行移動する)。
    // 床より下に行かないのは、回転の仰角の下限 (maxPolarAngle) と合わせて、カメラが床すれすれまで下がらないようにするため
    const { target } = controls
    const horizontal = Math.hypot(target.x, target.z)
    const pull = horizontal > PAN_RADIUS ? 1 - PAN_RADIUS / horizontal : 0
    panCorrection.set(-target.x * pull, THREE.MathUtils.clamp(target.y, 0, PAN_HEIGHT) - target.y, -target.z * pull)
    target.add(panCorrection)
    camera.position.add(panCorrection)
  }
  if (focusParams.autofocus && dofEnabled) updateFocus(delta)
  if (timeOfDay.update()) invalidate() // 光を変えるのは、時計の分が変わった時と GUI の Time を動かした時だけ
  hud.update()
  resolution.update(timing) // 動いている間に重すぎる状態が続いたら、動いている間の描画倍率を下げる

  // 前に描いた時から見て分かる変化が無ければ描かない (宝石が止まって眺めているだけの間、GPU をほぼ休ませる)。
  // 画面には最後に描いた絵が残る。?bench の時は、端末の余力を測るため毎コマ描く (コースティクスも落下中と同じく毎コマ計算する)
  // 動いている間は軽い描画倍率で描き、動きが止まって STILL_DELAY たったら、止まっている間の倍率 (くっきり) で1回描き直す
  // (resolution.ts)。落とし始めるまでは切り替えない (幕の裏で細かく描き直すと、落ち始めに倍率を戻す引っかかりが入るため)
  const now = performance.now()
  const moved = benchEnabled || visibleChange()
  if (moved) lastMotion = now
  const quiet = !moved && physics !== undefined && now - lastMotion > STILL_DELAY
  const settling = quiet && !resolution.still // 止まってくっきり描き直すコマ
  if (!moved && !needsRender && !settling) return
  needsRender = false
  if (moved) crossfade.cancel() // 溶かしている途中で動き出したら、重ねた絵をすぐ消す
  if (settling) {
    // 画面に出ている軽い絵を、同じ状態でもう一度描いて写し取り、上に重ねる (粒子の模様も変えないので同じ絵になる)
    renderFrame(frameStart, false)
    crossfade.capture()
  }
  resolution.setStill(quiet) // 倍率を変えたら画面の中身が消えるので、このコマで必ず描く
  renderFrame(frameStart)
  // 重ねた軽い絵を徐々に透明にして、くっきりした絵へ溶かす
  if (settling) crossfade.fadeOut()
})

// 1コマ描く。grain: フィルムの粒子の模様を変えるか
function renderFrame(frameStart: number, grain = true) {
  bokehScale.value = bokeh.scale * resolution.pixelScale()
  rememberRendered()
  studio.update()
  caustics.update(benchEnabled)
  if (grain) lens.update()
  pipeline.render()
  timing.record(frameStart)
  // 宝石を1回描き終えたら、最後の条件がそろう (最初の描画はシェーダーの組み立てで時間がかかるので、幕の裏で済ませる。
  // その前に落とし始めると、落ち始めがかくつく)
  if (gems.length > 0) loader.complete('firstFrame')
}

// 条件がそろったら幕を上げ、上げ終わったら落とし始める
loader.ready
  .then(loader.hide)
  .then(() => {
    physics = preparedPhysics
    physics?.start()
  })
