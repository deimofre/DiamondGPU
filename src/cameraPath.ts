import * as THREE from 'three/webgpu'

// 落下アニメーションに合わせたカメラワーク
// キーフレーム(アニメーションの時刻とカメラ位置)を滑らかな曲線でつなぎ、再生時刻からカメラ位置を決める。
// 注視点は原点のまま。ループの先頭に戻る時はカメラも最初の位置に切り替わる(宝石も空中に戻るのでカット扱い)
type CameraKey = { time: number; position: [number, number, number] }

const KEYS: CameraKey[] = [
  { time: 0, position: [1.0, 10.5, 4.0] }, // 真上寄りから、空中の宝石を見下ろす
  { time: 2.5, position: [4.2, 3.4, 3.8] }, // 着地に合わせて横へ回り込む
  { time: 5.5, position: [4.0, 1.3, -2.4] }, // 低い位置まで下りながら回り込み続ける
  { time: 8.5, position: [2.8, 1.1, -3.6] }, // 着地した宝石に寄る
  { time: 10, position: [2.6, 1.05, -3.7] }, // ほぼ止まった状態で終わる
]

// 時刻 → カメラ位置 の関数を返す
export function createCameraPath(keys: CameraKey[] = KEYS) {
  const curve = new THREE.CatmullRomCurve3(
    keys.map((key) => new THREE.Vector3(...key.position)),
    false,
    'centripetal', // 曲線がキーの間で膨らみすぎないようにする
  )
  const last = keys.length - 1
  return (time: number, target: THREE.Vector3) => {
    const t = THREE.MathUtils.clamp(time, keys[0].time, keys[last].time)
    let k = 0
    while (k < last - 1 && t > keys[k + 1].time) k++
    const f = (t - keys[k].time) / (keys[k + 1].time - keys[k].time)
    // getPoint(u) はキーを等間隔に割り当てるので、区間番号+区間内の割合で指定するとキーの時刻ちょうどに通る
    return curve.getPoint((k + f) / last, target)
  }
}
