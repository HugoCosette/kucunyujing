// Electron 主进程：把 dist-desktop 通过固定的 app:// 协议交给渲染进程。
//
// 为什么不用 loadFile / file://：Chromium 在 file:// 下不提供 IndexedDB，且 module Worker、
// fetch 静态 JSON 都会失败。固定 origin（app://kucunyujing）才能让 IndexedDB / localStorage
// 长期稳定，换协议名等于换数据库，用户数据会「凭空消失」。
const { app, BrowserWindow, protocol, session, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const APP_SCHEME = 'app'
const APP_HOST = 'kucunyujing'
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
const DEV_URL = process.env.VITE_DEV_SERVER_URL
const OPEN_DEVTOOLS = process.env.ELECTRON_DEVTOOLS === '1'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

function webRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.join(__dirname, '..', 'dist-desktop')
}

function resolveInsideRoot(root, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
  const rootPath = path.resolve(root)
  const target = path.resolve(rootPath, relative || 'index.html')
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) return null
  return target
}

async function readStatic(root, pathname) {
  const file = resolveInsideRoot(root, pathname)
  if (!file) return null
  try {
    return { body: await fs.readFile(file), type: MIME_TYPES[path.extname(file).toLowerCase()] }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // 兜底：无扩展名的路径回落到 index.html（hash 路由下基本走不到）。
    if (path.extname(file)) return null
    return { body: await fs.readFile(path.join(root, 'index.html')), type: MIME_TYPES['.html'] }
  }
}

function registerProtocolHandler() {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const { pathname } = new URL(request.url)
      const file = await readStatic(webRoot(), pathname)
      if (!file) return new Response('Not Found', { status: 404 })

      const type = file.type ?? 'application/octet-stream'
      const headers = { 'content-type': type }
      // index.html 不缓存，换前端包后立刻生效；带 hash 的资源可以长缓存。
      headers['cache-control'] = type === MIME_TYPES['.html'] ? 'no-cache' : 'public, max-age=31536000, immutable'
      return new Response(file.body, { headers })
    } catch (error) {
      console.error('[app://] 读取资源失败', request.url, error)
      return new Response('Internal Error', { status: 500 })
    }
  })
}

function setupDownloads() {
  session.defaultSession.on('will-download', (event, item) => {
    // 导出 Excel 走 <a download>：默认会弹保存对话框，这里只把默认目录换成「下载」。
    item.setSaveDialogOptions({
      title: '保存文件',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
    })
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    title: '备货决策系统',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  const isInternalUrl = (url) =>
    url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`) || (DEV_URL ? url.startsWith(DEV_URL) : false)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)

  if (OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' })
  return win
}

app.setAppUserModelId('com.kucunyujing.stocking')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    if (!DEV_URL) registerProtocolHandler()
    setupDownloads()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
