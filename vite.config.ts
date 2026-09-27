import { defineConfig } from 'vite'
import fs from 'node:fs'

// 開発用HTTPSの証明書 (mkcert で各マシンで作る)。無ければ普通の http で起動する
const hasCerts = fs.existsSync('certs/key.pem') && fs.existsSync('certs/cert.pem')

export default defineConfig({
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
