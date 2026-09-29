import * as THREE from 'three/webgpu'

// 描いたコマごとの時間の記録。確認用の表示 (debug.ts) と、描画倍率の自動調整 (resolution.ts) が読む
// - CPU: そのコマの JS の時間 (アニメーションループの始まりから、描画の命令を GPU に送り終えるまで)
// - GPU: GPU がそのコマの仕事に取りかかってから終えるまでの時間 (目安)。取りかかれるのは、送り終えた時と
//   前のコマの仕事を終えた時の遅い方 (送り終えた時から数えると、GPU が前のコマを抱えている時にその待ちまで入って倍近くに出た)。
//   WebGPU の queue.onSubmittedWorkDone で測るので、WebGL2 では取れない (undefined のまま)
const KEEP = 5000 // 記録を残す長さ (ms)

export type FrameRecord = { time: number; cpu: number; gpu?: number }

// WebGPU の、送った仕事を GPU が終えた時に解決する関数 (WebGL2 には無い)
type GpuQueue = { onSubmittedWorkDone(): Promise<void> }

export function createFrameTiming(renderer: THREE.WebGPURenderer) {
  const queue = (renderer.backend as { device?: { queue: GpuQueue } }).device?.queue
  const frames: FrameRecord[] = []
  let lastDone = 0

  // pipeline.render() の後に呼ぶ。start はそのコマのアニメーションループの始まりの時刻
  function record(start: number) {
    const time = performance.now()
    const frame: FrameRecord = { time, cpu: time - start }
    frames.push(frame)
    while (frames[0].time < time - KEEP) frames.shift()
    queue?.onSubmittedWorkDone().then(() => {
      const done = performance.now()
      frame.gpu = done - Math.max(time, lastDone)
      lastDone = done
    })
  }

  // from〜to の間に描いたコマ
  const between = (from: number, to = Infinity) => frames.filter((frame) => frame.time >= from && frame.time <= to)

  return { record, between }
}

export type FrameTiming = ReturnType<typeof createFrameTiming>

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
