// 桌面开发模式：用 Vite 的 API 起开发服务器，再把地址交给 Electron 主进程加载。
// 这样改 .vue / .js 保存即 HMR，不需要每次重新打包。
import { spawn } from 'node:child_process'

import electronPath from 'electron'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1' } })
await server.listen()
server.printUrls()

const devUrl = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5173/'

// 额外参数透传给 Electron，例如 npm run desktop:dev -- --remote-debugging-port=9335
const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
})

let closing = false
function shutdown(code = 0) {
  if (closing) return
  closing = true
  server.close().finally(() => process.exit(code))
}

child.on('exit', (code) => shutdown(code ?? 0))
child.on('error', (error) => {
  console.error('启动 Electron 失败', error)
  shutdown(1)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill()
    shutdown(0)
  })
}
