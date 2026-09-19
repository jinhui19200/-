#!/usr/bin/env node
/**
 * 浏览器预览：把渲染进程跑在浏览器里，配一个内存版数据后端。
 *
 * 用途：不启动 Electron 也能看界面、点交互（沙箱 / CI 里也能跑）。
 *
 * 做法刻意只生成两个文件（index.html + mock-api.js），资源用相对路径指回
 * `out/renderer`，因此不需要复制整个构建产物，也就没有「旧文件越积越多」的问题。
 *
 * 用法：先 `npm run build`，再 `node preview/build-preview.mjs`
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
const rendererDir = join(outDir, 'renderer')
const previewDir = join(outDir, 'preview')
const PORT = Number(process.env.PREVIEW_PORT ?? 8765)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

async function assemble() {
  let html
  try {
    html = await readFile(join(rendererDir, 'index.html'), 'utf8')
  } catch {
    console.error('\n  找不到 out/renderer/index.html，请先运行： npm run build\n')
    process.exit(1)
  }

  await mkdir(previewDir, { recursive: true })

  // 内存版后端
  execFileSync(
    join(root, 'node_modules', '.bin', 'esbuild'),
    [
      join(root, 'preview', 'mock.ts'),
      '--bundle',
      '--format=iife',
      '--platform=browser',
      `--alias:@shared=${join(root, 'src', 'shared')}`,
      `--outfile=${join(previewDir, 'mock-api.js')}`,
      '--log-level=warning'
    ],
    { stdio: 'inherit' }
  )

  // 资源指回 out/renderer，并让 mock 先于模块脚本执行
  // （模块脚本是 defer 的，普通脚本会立即执行，所以顺序天然正确）
  const patched = html
    .replace(/\.\/assets\//g, '../renderer/assets/')
    .replace(
      '<script type="module"',
      '<script src="./mock-api.js"></script>\n    <script type="module"'
    )

  await writeFile(join(previewDir, 'index.html'), patched, 'utf8')
}

function serve() {
  const server = createServer(async (req, res) => {
    let pathname = '/preview/'
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      /* 用默认值 */
    }
    if (pathname.endsWith('/')) pathname += 'index.html'

    const file = resolve(outDir, '.' + pathname)
    // 防目录穿越
    if (file !== outDir && !file.startsWith(outDir + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('403')
      return
    }

    try {
      const data = await readFile(file)
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404')
    }
  })

  return new Promise((ok) => {
    server.listen(PORT, '127.0.0.1', () => ok(server))
  })
}

await assemble()
await serve()

const url = `http://127.0.0.1:${PORT}/preview/`
console.log('')
console.log(`  预览地址   ${url}`)
console.log('  演示模式   数据只存在浏览器内存里，刷新即重置')
console.log('  停止服务   按 Ctrl+C')
console.log('')

if (process.platform === 'darwin' && !process.env.PREVIEW_NO_OPEN) {
  try {
    execFileSync('open', [url])
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}
