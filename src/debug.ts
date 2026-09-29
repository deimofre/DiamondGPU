import * as THREE from 'three/webgpu'
import { quality } from './quality'
import type { FrameTiming } from './frameTiming'

// 確認用の表示 (URL に ?debug を付けた時だけ)。画面の左上に、描画の方式・画質の設定 (quality.ts)・描画の倍率と解像度・
// 1秒あたりに描いた回数と、1コマにかかった時間 (frameTiming.ts) を出す (スマホでも右上の lil-gui と重ならないよう、短く分ける)。
// 止まって眺めている間は描画を省くので「idle」になる。
// 調整用の lil-gui も最初から出す (スマホには出し入れの G キーが無いため)
//
// ?bench は端末の余力を測るためのもの (?debug も兼ねる)。変化が無くても毎コマ描き、コースティクスも毎コマ計算し直す
// (落下中と同じ仕事量を、止まった画面のまま続ける)。?debug だけだと、描く必要が無い間は描かないので fps が低く出て、
// 端末が遅いのか描いていないだけなのか見分けられないため。描画倍率の自動調整 (resolution.ts) も止めて、倍率を固定して測る。
// さらに、宝石とカメラが止まったら負荷の内訳を自動で測る (runBench): 効果を1つずつ外して GPU の時間を測り、表にして出す
export const benchEnabled = new URLSearchParams(location.search).has('bench')
export const debugEnabled = new URLSearchParams(location.search).has('debug') || benchEnabled

const MAX_GAP = 200 // これより空いた間隔は「止まっていた間」とみなし、描く速さの計算に入れない (ms)
const SETTLE = 2000 // 内訳: 効果を外してから測り始めるまで (シェーダーの作り直しと、描く速さが落ち着くのを待つ。ms)
const MEASURE = 2000 // 内訳: 1項目を測る長さ (ms)

// 内訳の1項目。apply で効果を外し (その前の状態を覚えておき)、revert で戻す
export type BenchStep = { label: string; apply(): void; revert(): void }

// describe: 描画倍率の行に添える状態 (resolution.ts の自動調整など)
export function createDebugOverlay(renderer: THREE.WebGPURenderer, timing: FrameTiming, describe: () => string = () => '') {
  if (!debugEnabled) return { runBench(_steps: BenchStep[]) {} }

  const element = document.createElement('div')
  element.className = 'debug'
  document.body.appendChild(element)
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'
  const size = new THREE.Vector2()
  let table: string[] = [] // 内訳の表 (測り終えた項目から順に増える)

  const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

  // from〜to の間に描いたコマの、描く速さと CPU・GPU の時間
  function stats(from: number, to: number) {
    const range = timing.between(from, to)
    const gaps = range.slice(1).map((frame, i) => frame.time - range[i].time).filter((gap) => gap <= MAX_GAP)
    const gpu = range.flatMap((frame) => (frame.gpu === undefined ? [] : [frame.gpu]))
    return {
      gap: gaps.length > 0 ? average(gaps) : undefined,
      max: gaps.length > 0 ? Math.max(...gaps) : undefined,
      cpu: range.length > 0 ? average(range.map((frame) => frame.cpu)) : undefined,
      gpu: gpu.length > 0 ? average(gpu) : undefined,
    }
  }

  function show() {
    const now = performance.now()
    const lines = [`${backend} · ${quality.name}${benchEnabled ? ' · bench' : ''}`]
    renderer.getDrawingBufferSize(size)
    const state = describe()
    lines.push(`${renderer.getPixelRatio().toFixed(2)}x ${size.x}×${size.y}${state ? ` ${state}` : ''}`)
    const { gap, max, cpu, gpu } = stats(now - 1000, now)
    if (gap === undefined) {
      lines.push('idle')
    } else {
      lines.push(`${Math.round(1000 / gap)} fps ${gap.toFixed(1)}ms (max ${Math.round(max!)})`)
      lines.push(`CPU ${cpu!.toFixed(1)}ms${gpu !== undefined ? ` · GPU ${gpu.toFixed(1)}ms` : ''}`)
    }
    element.textContent = [...lines, ...table].join('\n')
  }
  setInterval(show, 500)

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  // 負荷の内訳を測る。先頭の項目 (何も外さない) を基準に、外した時にどれだけ減ったかを並べる。
  // 最後にもう一度基準を測り、端末が熱で遅くなっていないかを見る (最初と大きく違えば、途中の値も当てにならない)
  async function runBench(steps: BenchStep[]) {
    table = ['', 'GPU ms   fps   (差)']
    let base: number | undefined
    for (const step of steps) {
      table.push(`${step.label.padEnd(11)} …`)
      step.apply()
      await wait(SETTLE)
      const from = performance.now()
      await wait(MEASURE)
      const { gap, gpu } = stats(from, performance.now())
      step.revert()
      base ??= gpu
      const diff = gpu !== undefined && base !== undefined && step !== steps[0] ? ` ${gpu - base >= 0 ? '+' : ''}${(gpu - base).toFixed(1)}` : ''
      table[table.length - 1] = `${step.label.padEnd(11)}${gpu?.toFixed(1).padStart(5) ?? '    -'} ${gap ? String(Math.round(1000 / gap)).padStart(4) : '   -'}${diff}`
    }
    table.push('done')
  }

  return { runBench }
}
