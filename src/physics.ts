import * as THREE from 'three/webgpu'
import RAPIER from '@dimforge/rapier3d'

// 宝石の落下の物理シミュレーション (Rapier)
//
// 以前は Blender で焼き込んだ落下アニメーションを再生していた。今の GLB にはその最初の姿勢(空中)だけが入っていて
// (アニメーションは外した)、start() でそこから落とし始める。見る人の操作で結果が変わるようにするための土台。
// - Rapier の wasm (約3MB) は別ファイルで、このモジュールを読み込んだ時点で初期化まで済む。
//   最初の絵を待たせないよう、main.ts が import() で後から読む
//   (以前の rapier3d-compat は wasm を base64 で JS に埋め込んでいて、JS 全体の7割を占めていた)
// - 当たり判定は宝石の形そのままの凸包 (内部反射シェーダーも凸の前提なので、見た目と一致する)
// - 床は y=0 が上面の厚みのある板
// - 描画のフレームとは切り離し、1/120秒刻みの固定ステップで進める (フレームレートが違っても同じ動きになる)
// - 止まった宝石は Rapier が休止させるので位置が変わらなくなり、コースティクスの計算も省かれる
const STEP = 1 / 120
const MAX_STEPS = 8 // 1フレームで進める上限 (タブに戻った直後などに一気に進めない)
const GRAVITY = -9.81
const FRICTION = 0.5 // 摩擦 (Blender の剛体の初期値と同じ)
const RESTITUTION = 0.2 // 跳ね返り

// gems: 同じジオメトリを共有する宝石。親の変換が無い(シーン直下)前提で、位置と向きを直接書き換える
export function createGemPhysics(gems: THREE.Mesh[]) {
  const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
  world.timestep = STEP

  world.createCollider(
    RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0).setFriction(FRICTION).setRestitution(RESTITUTION),
  )

  const position = gems[0].geometry.getAttribute('position')
  const points = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) points.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3)

  // 最初の姿勢 (start のたびにここへ戻す)
  const initial = gems.map((gem) => ({ position: gem.position.clone(), quaternion: gem.quaternion.clone() }))
  const bodies = gems.map((gem) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(gem.position.x, gem.position.y, gem.position.z)
        .setRotation(gem.quaternion),
    )
    const hull = RAPIER.ColliderDesc.convexHull(points)
    if (!hull) throw new Error('宝石の凸包を作れませんでした')
    world.createCollider(hull.setFriction(FRICTION).setRestitution(RESTITUTION), body)
    return body
  })

  let running = false
  let time = 0 // start してからの経過時間 (カメラワークに使う)
  let accumulator = 0
  const zero = { x: 0, y: 0, z: 0 }

  // 最初の姿勢に戻して落とし始める (何度押しても最初からやり直す)
  function start() {
    bodies.forEach((body, i) => {
      body.setTranslation(initial[i].position, true)
      body.setRotation(initial[i].quaternion, true)
      body.setLinvel(zero, true)
      body.setAngvel(zero, true)
    })
    running = true
    time = 0
    accumulator = 0
  }

  // 毎フレーム呼ぶ。delta は経過時間(秒)
  function update(delta: number) {
    if (!running) return
    accumulator = Math.min(accumulator + delta, STEP * MAX_STEPS)
    while (accumulator >= STEP) {
      world.step()
      accumulator -= STEP
      time += STEP
    }
    gems.forEach((gem, i) => {
      const t = bodies[i].translation()
      const r = bodies[i].rotation()
      gem.position.set(t.x, t.y, t.z)
      gem.quaternion.set(r.x, r.y, r.z, r.w)
    })
  }

  // 宝石を突く (タップ)。velocity は与えたい速度の変化 (ワールド座標)。質量を掛けて力積にするので、重さによらず同じ動きになる。
  // 突いた位置 point が重心からずれているほど回転もかかる。spin はその回転の割合
  // (位置どおりに全部かけると、縁を突いた時に1秒に数回転して落ち着きがないので弱められるようにしている)。
  // 落とす前に突いた時は、その場から落とし始める
  function poke(gem: THREE.Object3D, point: THREE.Vector3, velocity: THREE.Vector3, spin: number) {
    const i = gems.indexOf(gem as THREE.Mesh)
    if (i < 0) return
    if (!running) start()
    const body = bodies[i]
    const impulse = velocity.clone().multiplyScalar(body.mass())
    const com = body.worldCom()
    const torque = point.clone().sub(new THREE.Vector3(com.x, com.y, com.z)).cross(impulse).multiplyScalar(spin)
    body.applyImpulse(impulse, true)
    body.applyTorqueImpulse(torque, true)
  }

  return {
    start,
    update,
    poke,
    get time() { return time },
    get running() { return running },
    // 全部の宝石が止まった (Rapier が休止させた)
    get settled() { return running && bodies.every((body) => body.isSleeping()) },
  }
}

// main.ts は物理を後から読むので、型だけを先に使う (import type は実行時に読み込まない)
export type GemPhysics = ReturnType<typeof createGemPhysics>
