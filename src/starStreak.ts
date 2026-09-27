import * as THREE from 'three/webgpu'
import {
  Fn, If, Loop, bool, convertToTexture, cos, float, int, luminance, max, pow, screenSize, screenUV, select, sin,
  uniform, vec2, vec3, vec4,
} from 'three/tsl'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import type { GUI } from 'three/addons/libs/lil-gui.module.min.js'

// 光条 (スターフィルター)。ジュエリー写真で強い輝きから伸びる十字の光の筋
// 1. 半分の解像度で、しきい値を超えていて、かつ周囲より明るい点(輝きの頂点)だけを取り出す。
//    明るい領域の全ピクセルから筋を出すと、平行な筋が束になって縞模様(ギザギザ)に見えるため、
//    1つの輝きから1本だけ出す。輝き全体の明るさは頂点に集める
// 2. 頂点をわずかにぼかして、斜めの筋でも線の断面がなめらか(アンチエイリアス)になるようにする
// 3. 数本の方向に沿って少しずつずらしながら足し合わせる。遠いほど弱くして先細りにする
const SAMPLES = 48 // 1方向あたりのサンプル数。多いほど筋が滑らかだが重い
const NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]

export function createStarStreak(input: THREE.TextureNode, gui: GUI) {
  const threshold = uniform(3.0) // この明るさ(トーンマッピング前)を超えた分だけが光る
  const strength = uniform(0.32)
  const length = uniform(0.12) // 筋の長さ (画面の高さに対する割合。解像度が変わっても同じ長さになる)
  const axes = uniform(2, 'int') // 光の筋の軸の数。2で十字(4本)、3で6本、4で8本
  const angle = uniform(0.3) // 筋の向き (ラジアン)

  // しきい値を超えた分の色
  const excessOf = (color: THREE.Node<'vec3'>) => {
    const brightness = luminance(color)
    return color.mul(max(brightness.sub(threshold), 0).div(max(brightness, 1e-4)))
  }

  const peaks = convertToTexture(
    Fn(() => {
      const texel = vec2(1).div(screenSize) // この処理(半分の解像度)の1ピクセル
      const center = input.sample(screenUV).rgb
      const brightness = luminance(center)
      const isPeak = bool(brightness.greaterThan(threshold)).toVar()
      const energy = excessOf(center).toVar()
      for (const [dx, dy] of NEIGHBORS) {
        const neighbor = input.sample(screenUV.add(texel.mul(vec2(dx, dy)))).rgb
        If(luminance(neighbor).greaterThan(brightness), () => {
          isPeak.assign(bool(false))
        })
        energy.addAssign(excessOf(neighbor))
      }
      return vec4(select(isPeak, energy, vec3(0)), 1)
    })(),
  ).setResolutionScale(0.5)
  const softPeaks = gaussianBlur(peaks, 1, 1).getTextureNode()

  const streaks = convertToTexture(
    Fn(() => {
      const sum = vec3(0).toVar()
      Loop({ start: int(0), end: axes, type: 'int' }, ({ i }) => {
        const a = angle.add(float(i).mul(Math.PI).div(float(axes)))
        const aspect = screenSize.y.div(screenSize.x)
        const step = vec2(cos(a).mul(aspect), sin(a)).mul(length.div(SAMPLES))
        Loop({ start: int(1), end: int(SAMPLES + 1), type: 'int' }, ({ i: j }) => {
          const weight = pow(float(1).sub(float(j).div(SAMPLES + 1)), 2)
          const offset = step.mul(float(j))
          sum.addAssign(softPeaks.sample(screenUV.add(offset)).rgb.add(softPeaks.sample(screenUV.sub(offset)).rgb).mul(weight))
        })
      })
      return vec4(sum.mul(strength).div(SAMPLES), 1)
    })(),
  ).setResolutionScale(0.5)

  const folder = gui.addFolder('Star')
  folder.add(strength, 'value', 0, 3).name('strength')
  folder.add(threshold, 'value', 0, 20).name('threshold')
  folder.add(length, 'value', 0.01, 0.5).name('length')
  folder.add(axes, 'value', { '4本': 2, '6本': 3, '8本': 4 }).name('rays')
  folder.add(angle, 'value', 0, Math.PI).name('angle')

  return streaks.rgb
}
