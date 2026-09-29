import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import fs from 'node:fs'

// 開発用HTTPSの証明書 (mkcert で各マシンで作る)。無ければ普通の http で起動する
const hasCerts = fs.existsSync('certs/key.pem') && fs.existsSync('certs/cert.pem')

export default defineConfig({
  // Rapier (物理) の wasm を JS に埋め込まず、別の .wasm ファイルとして読む (physics.ts)
  plugins: [wasm()],
  server: {
    host: true, // LAN内の他端末(携帯等)からアクセス可能にする
    https: hasCerts
      ? {
          key: fs.readFileSync('certs/key.pem'),
          cert: fs.readFileSync('certs/cert.pem'),
        }
      : undefined,
  },
})
