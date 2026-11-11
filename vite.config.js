import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const STOCKING_CONFIG_FILE = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'src/stocking/config.json',
)

const MANUAL_SKUS_FILE = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'src/stocking/manualSkus.json',
)

const PURCHASE_SETTINGS_FILE = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'src/purchase/settings.json',
)

const PURCHASE_ORDERS_FILE = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'src/purchase/orders.json',
)

// 清单类 JSON：保存后不触发 HMR，避免编辑下单数据把已导入的库存整页刷掉。
const WATCHED_CONFIG_FILES = [
  STOCKING_CONFIG_FILE,
  MANUAL_SKUS_FILE,
  PURCHASE_SETTINGS_FILE,
  PURCHASE_ORDERS_FILE,
]

// 把 src/stocking/*.json 当成可写配置：开发态由页面直接落盘；
// 同时屏蔽这两个文件的 HMR，避免保存配置触发整页刷新丢掉已导入的库存数据。
function stockingConfigFilePlugin() {
  return {
    name: 'stocking-config-file',
    configureServer(server) {
      // 配置文件只在页面启动时读取：取消监听，避免保存后触发 HMR 重建页面组件。
      for (const file of WATCHED_CONFIG_FILES) server.watcher.unwatch(file)

      function registerSaveRoute(route, target) {
        server.middlewares.use(route, (request, response, next) => {
          if (request.method !== 'POST') {
            next()
            return
          }

          const chunks = []
          request.on('data', (chunk) => chunks.push(chunk))
          request.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8')
              const parsed = JSON.parse(body)
              fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
              response.statusCode = 204
              response.end()
            } catch (error) {
              response.statusCode = 400
              response.end(error instanceof Error ? error.message : 'invalid json')
            }
          })
        })
      }

      registerSaveRoute('/__stocking-config/save', STOCKING_CONFIG_FILE)
      registerSaveRoute('/__stocking-manual/save', MANUAL_SKUS_FILE)
      registerSaveRoute('/__purchase-settings/save', PURCHASE_SETTINGS_FILE)
      registerSaveRoute('/__purchase-orders/save', PURCHASE_ORDERS_FILE)
    },
    handleHotUpdate(context) {
      if (WATCHED_CONFIG_FILES.includes(context.file)) return []
      return undefined
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // GitHub Pages 项目站点部署在 https://<user>.github.io/<repo>/ 子路径下，
  // 打包产物必须带该前缀；本地 dev / preview 仍走根路径，避免影响日常开发。
  // 若之后改用自定义域名（部署在根路径），把这里改成 '/'。
  base: command === 'build' ? '/kucunyujing/' : '/',
  plugins: [vue(), stockingConfigFilePlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
}))
