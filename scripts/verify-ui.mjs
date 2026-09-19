#!/usr/bin/env node
/**
 * 界面自检：在真实浏览器里驱动界面 —— 既**量几何**，也**跑交互**。
 *
 * 三个验证层各管一段，互不替代：
 *   verify:store     数据层   纯 Node 直接调 store 模块
 *   verify:electron  端到端   隐藏窗口跑真 Electron：IPC + 磁盘
 *   verify:ui        界面     真实浏览器：布局几何 + 点得动 / 筛得对
 *
 * 布局部分刻意**量数字而不是看截图**：表头与数据是否对齐、列分割线在不在、
 * 有没有意外的横向滚动 —— 这些「看着差不多」的问题只有量出来才能判定，
 * 截图也证明不了「修好了」。
 *
 * 用法：npm run verify:ui   （npm 脚本会先构建，保证测的是当前代码）
 * 退出码：0 全部通过 / 1 有失败项
 *
 * 可选环境变量：
 *   VERIFY_UI_PORT    预览服务端口（默认 8791，刻意避开 8765，免得和手动开的预览打架）
 *   VERIFY_UI_SHOTS=1 把截图写到 out/verify-ui/（out/ 已在 .gitignore 里）
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.VERIFY_UI_PORT ?? 8791)
const BASE = `http://127.0.0.1:${PORT}/preview/`
const SHOT_DIR = join(ROOT, 'out', 'verify-ui')
const WANT_SHOTS = process.env.VERIFY_UI_SHOTS === '1'

let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  console.error('\n  未找到 playwright。安装方式：')
  console.error('    npm i -D playwright && npx playwright install chromium\n')
  process.exit(2)
}

// ── 断言与输出 ──────────────────────────────────────────────
let passed = 0
let failed = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  \u2713 ${label}`)
  } else {
    failed++
    failures.push(label + (detail ? ` \u2014 ${detail}` : ''))
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ── 预览服务生命周期 ────────────────────────────────────────
async function newestMtime(dir) {
  let newest = 0
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const e of entries) {
    if (!e.isFile()) continue
    const p = join(e.parentPath ?? dir, e.name)
    const s = await stat(p)
    if (s.mtimeMs > newest) newest = s.mtimeMs
  }
  return newest
}

async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'preview', 'build-preview.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PREVIEW_NO_OPEN: '1', PREVIEW_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += String(d)
  })

  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) {
      throw new Error(`预览服务启动失败（退出码 ${child.exitCode}）\n${stderr.trim()}`)
    }
    try {
      const res = await fetch(BASE)
      if (res.ok) return child
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  child.kill()
  throw new Error('预览服务 15 秒内未就绪')
}

// ── 页面操作辅助 ────────────────────────────────────────────
const switchTab = (page, name) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button.tab')].find((x) => x.textContent.trim() === t)
    if (b) b.click()
  }, name)

/** React 受控输入必须用原生 setter 才能触发 onChange */
const setInput = (page, selector, value) =>
  page.evaluate(
    ([sel, val]) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error('找不到 ' + sel)
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    [selector, value]
  )

const rowCount = (page) => page.evaluate(() => document.querySelectorAll('tbody tr').length)

const countLabel = (page) =>
  page.evaluate(() => document.querySelector('.count')?.textContent?.trim() ?? '')

/** 仓库页某个物品所在行的各单元格文本 */
const warehouseRow = (page, name) =>
  page.evaluate((n) => {
    const tr = [...document.querySelectorAll('tbody tr')].find(
      (r) => r.querySelector('td')?.textContent?.trim() === n
    )
    if (!tr) return null
    return [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
  }, name)

/**
 * 量表格：每列的表头与数据是否对齐、有没有列分割线。
 *
 * 判据要点（踩过坑）：
 *  - 不能拿「表头文字框」和「数据文字框」直接比左右边缘 —— 两边文字长度不同，
 *    左对齐列比右边缘必然不等。只看**对齐属性所指的那条边**。
 *  - JSX 里 `本月入库（{monthLabel}）` 会拆成多个文本节点，只取首个节点会量到
 *    残缺的「本月入库（」。必须取整个元素内容的并集框。
 *  - 数据侧若是元素（按钮/标签），以那个元素的框为基准，别比它内部的文字。
 */
const MEASURE_TABLE = () => {
  const contentBox = (el) => {
    if (!el) return null
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    return b.width > 0 ? { left: Math.round(b.left), right: Math.round(b.right) } : null
  }
  return [...document.querySelectorAll('table.table')].map((t) => {
    const ths = [...t.querySelectorAll('thead th')]
    const tr = t.querySelector('tbody tr')
    const tds = tr ? [...tr.querySelectorAll('td')] : []
    return ths.map((th, i) => {
      const td = tds[i]
      const child = td && td.firstElementChild ? td.firstElementChild : null
      const anchor = child
        ? (() => {
            const b = child.getBoundingClientRect()
            return { left: Math.round(b.left), right: Math.round(b.right) }
          })()
        : contentBox(td)
      const h = contentBox(th)
      const hAlign = getComputedStyle(th).textAlign
      const rightAligned = hAlign === 'right' || hAlign === 'end'
      return {
        i,
        head: th.textContent.trim(),
        data: td ? td.textContent.trim().slice(0, 14) : '(无)',
        hAlign,
        dAlign: td ? getComputedStyle(td).textAlign : null,
        rightAligned,
        thBorderRight: parseFloat(getComputedStyle(th).borderRightWidth),
        tdBorderRight: td ? parseFloat(getComputedStyle(td).borderRightWidth) : null,
        isLast: i === ths.length - 1,
        edgeDelta: h && anchor ? (rightAligned ? anchor.right - h.right : anchor.left - h.left) : null
      }
    })
  })
}

// ── 主流程 ──────────────────────────────────────────────────
async function run(page, shot) {
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

  const dialogs = []
  page.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: d.message() })
    d.accept()
  })

  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1200)

  // ── 1. 首屏 ──────────────────────────────────────────────
  section('1. 首屏与桥接')
  check('界面已挂载', (await page.evaluate(() => document.querySelectorAll('#root *').length)) > 0)
  const bridge = await page.evaluate(
    () => document.querySelector('.bridge-status')?.textContent ?? ''
  )
  check('处于演示模式（非 Electron 环境，提示未检测到主进程）', bridge.length > 0, bridge)
  check('无「已从备份恢复」提示条', (await page.evaluate(() => !document.querySelector('.warn-banner'))))
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('button.tab')].map((b) => b.textContent.trim())
  )
  check('三个页签：仓库 / 记录 / 操作', tabs.join('|') === '仓库|记录|操作', tabs.join('|'))
  check('仓库页默认渲染 5 种物品', (await rowCount(page)) === 5, `${await rowCount(page)}`)
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('.content')
    return { s: el.scrollWidth, c: el.clientWidth }
  })
  check('无意外横向滚动', overflow.s <= overflow.c + 1, `scrollWidth=${overflow.s} clientWidth=${overflow.c}`)
  await shot(page, '1-warehouse')

  // ── 2. 仓库页布局 ────────────────────────────────────────
  section('2. 仓库页：表头对齐与列分割线')
  let tables = await page.evaluate(MEASURE_TABLE)
  check('页面上有且只有一个表格', tables.length === 1, `${tables.length}`)
  let cols = tables[0]
  const numeric = cols.filter((c) => c.head === '数量' || c.head.startsWith('本月'))
  check(
    '数值列表头右对齐（历史缺陷：被 .table th 的选择器权重压成左对齐）',
    numeric.every((c) => c.rightAligned),
    numeric.map((c) => `${c.head}=${c.hAlign}`).join('  ')
  )
  check('数值列表头与数据的对齐属性一致', numeric.every((c) => c.hAlign === c.dAlign))
  for (const c of cols) {
    check(
      `「${c.head}」表头与数据对齐（比${c.rightAligned ? '右' : '左'}边缘）`,
      c.edgeDelta !== null && Math.abs(c.edgeDelta) <= 2,
      `差 ${c.edgeDelta}px`
    )
  }
  check(
    '除末列外每列都有 1px 列分割线（表头与数据一致）',
    cols.filter((c) => !c.isLast).every((c) => c.thBorderRight === 1 && c.tdBorderRight === 1),
    cols.map((c) => `${c.head}:${c.thBorderRight}/${c.tdBorderRight}`).join(' ')
  )
  check('末列不画右边框（避免与卡片边框叠成双线）', cols[cols.length - 1].thBorderRight === 0)

  // ── 3. 记录页布局 ────────────────────────────────────────
  section('3. 记录页：表头与数据一一对应')
  await switchTab(page, '记录')
  await page.waitForTimeout(400)
  tables = await page.evaluate(MEASURE_TABLE)
  check('页面上有且只有一个表格', tables.length === 1, `${tables.length}`)
  cols = tables[0]
  check(
    '表头为 时间/名称/数量/单位/操作人/类型/操作',
    cols.map((c) => c.head).join('|') === '时间|名称|数量|单位|操作人|类型|操作',
    cols.map((c) => c.head).join('|')
  )
  check('没有空表头（历史缺陷：按钮列没有表头）', cols.every((c) => c.head !== ''))
  check('「类型」压在 出库/入库 标签上', cols[5].data === '出库', cols[5].data)
  check('「操作」压在 撤销 按钮上', cols[6].data === '撤销', cols[6].data)
  for (const c of cols) {
    check(`「${c.head}」表头与数据对齐`, Math.abs(c.edgeDelta) <= 2, `差 ${c.edgeDelta}px`)
  }
  check(
    '除末列外每列都有 1px 列分割线',
    cols.filter((c) => !c.isLast).every((c) => c.thBorderRight === 1 && c.tdBorderRight === 1)
  )
  check('记录页共 9 条种子数据', (await rowCount(page)) === 9, `${await rowCount(page)}`)
  await shot(page, '2-records')

  // ── 4. 名称 / 类型筛选 ───────────────────────────────────
  section('4. 名称与类型筛选')
  await setInput(page, '.search-input', '螺丝')
  await page.waitForTimeout(250)
  check('搜「螺丝」→ 4 条', (await rowCount(page)) === 4, `${await rowCount(page)}`)
  await setInput(page, '.search-input', '')
  await page.waitForTimeout(250)

  // 种子 9 条的构成（先 grep 数过）：入库 6 条、出库 3 条
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.filter-group button')]
      .find((b) => b.textContent.trim() === '出库')
      .click()
  })
  await page.waitForTimeout(250)
  check('筛「出库」→ 3 条', (await rowCount(page)) === 3, `${await rowCount(page)}`)
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.filter-group button')]
      .find((b) => b.textContent.trim() === '全部')
      .click()
  })
  await page.waitForTimeout(250)

  // ── 5. 时间范围（含当日） ────────────────────────────────
  // 种子数据的日期分布（先用 grep 数过，别凭印象）：
  //   09-19 六条（08:00 / 09:30 / 10:00 / 11:00 / 13:00 / 15:00）
  //   09-18 一条、09-17 一条、08-20 一条，共 9 条
  section('5. 时间范围筛选（含当日）')
  const setRange = async (from, to) => {
    await setInput(page, 'input[aria-label="起始日期"]', from)
    await setInput(page, 'input[aria-label="截止日期"]', to)
    await page.waitForTimeout(250)
  }

  await setRange('2026-09-19', '2026-09-19')
  check('起止同为 09-19 → 6 条', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  const times = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr td:first-child')].map((td) =>
      td.textContent.trim().slice(11)
    )
  )
  check(
    '含当日最早 08:00 与最晚 15:00（闭区间，不是半开）',
    times.includes('08:00') && times.includes('15:00'),
    times.join(',')
  )
  check(
    '标题显示「筛选出 6 / 共 9 条」',
    (await countLabel(page)).includes('筛选出 6 / 共 9 条'),
    await countLabel(page)
  )
  await shot(page, '3-date-single-day')

  await setRange('2026-09-17', '2026-09-19')
  check('09-17 ~ 09-19 → 8 条', (await rowCount(page)) === 8, `${await rowCount(page)}`)

  await setRange('', '2026-09-18')
  check('只填截止 09-18 → 3 条（该日及更早）', (await rowCount(page)) === 3, `${await rowCount(page)}`)

  await setRange('2026-08-20', '2026-08-20')
  check('单日 08-20 → 1 条（边界日当天命中）', (await rowCount(page)) === 1, `${await rowCount(page)}`)

  await setRange('2026-09-20', '2026-09-25')
  check('未来区间 → 0 条', (await rowCount(page)) === 0, `${await rowCount(page)}`)

  await setRange('2026-09-19', '2026-09-01')
  const emptyMsg = await page.evaluate(() => document.querySelector('.empty')?.textContent ?? '')
  check('起始晚于截止时明确提示，而不是笼统说「没有记录」', emptyMsg.includes('起始日期晚于截止日期'), emptyMsg)

  await setRange('2026-09-19', '2026-09-19')
  await setInput(page, '.search-input', '螺丝')
  await page.waitForTimeout(250)
  check('09-19 + 名称「螺丝」→ 3 条', (await rowCount(page)) === 3, `${await rowCount(page)}`)
  const exportLabel = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('导出'))
  )
  check('筛选时导出按钮标明条数', exportLabel === '导出 Excel（3 条）', exportLabel)
  await shot(page, '4-date-combined')

  await setInput(page, '.search-input', '')
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.date-range button')]
      .find((b) => b.textContent.trim() === '清除')
      .click()
  })
  await page.waitForTimeout(250)
  const cleared = await page.evaluate(() => ({
    from: document.querySelector('input[aria-label="起始日期"]').value,
    to: document.querySelector('input[aria-label="截止日期"]').value
  }))
  check('「清除」按钮清空两端日期', cleared.from === '' && cleared.to === '', JSON.stringify(cleared))
  check('清除后恢复 9 条', (await rowCount(page)) === 9, `${await rowCount(page)}`)

  // ── 6. 操作页表单 ────────────────────────────────────────
  section('6. 操作页表单')
  await switchTab(page, '操作')
  await page.waitForTimeout(400)

  const formWidths = await page.evaluate(() =>
    [...document.querySelectorAll('.tx-form')].map((f) =>
      [...f.querySelectorAll('input')].map((i) => Math.round(i.getBoundingClientRect().width))
    )
  )
  check(
    '入库表单五个输入框等宽（历史缺陷：名称/操作人在定位容器里没撑满）',
    new Set(formWidths[0]).size === 1,
    formWidths[0].join(', ')
  )
  check('出库表单五个输入框等宽', new Set(formWidths[1]).size === 1, formWidths[1].join(', '))

  const inForm = page.locator('.tx-form').first()
  const nameInput = inForm.locator('input[type="text"]').nth(0)
  const unitInput = inForm.locator('input[type="text"]').nth(1)
  const opInput = inForm.locator('input[type="text"]').nth(2)
  const qtyInput = inForm.locator('input[type="number"]')
  const submitBtn = inForm.locator('button[type="submit"]')

  // 6a 单位锁定
  await nameInput.fill('铜线 1.5mm²')
  await page.waitForTimeout(300)
  check('名称填已存在物品 → 单位自动带出「米」', (await unitInput.inputValue()) === '米', await unitInput.inputValue())
  check('单位框变为只读', (await unitInput.getAttribute('readonly')) !== null)
  const lockHint = await page.evaluate(() => document.querySelector('.tx-locked')?.textContent ?? '')
  check('单位标签显示「（已锁定）」', lockHint.includes('已锁定'), lockHint)

  // 6b 操作人补全
  await opInput.fill('张')
  await page.waitForTimeout(250)
  let suggestions = await page.evaluate(() =>
    [...document.querySelectorAll('.tx-suggestion')].map((b) => b.textContent.trim())
  )
  check('操作人输入「张」→ 提示含「张三」', suggestions.includes('张三'), suggestions.join(',') || '(无提示)')
  await opInput.fill('张三')
  await page.waitForTimeout(250)
  suggestions = await page.evaluate(() =>
    [...document.querySelectorAll('.tx-suggestion')].map((b) => b.textContent.trim())
  )
  check('已输入完整姓名后不再推荐自身（历史缺陷）', !suggestions.includes('张三'), suggestions.join(',') || '(无提示)')
  await opInput.fill('')

  // 6c 新物品自动建立
  await nameInput.fill('排针 2.54mm')
  await qtyInput.fill('300')
  await unitInput.fill('排')
  await page.waitForTimeout(200)
  check('新物品时提交按钮可用', !(await submitBtn.isDisabled()))
  await submitBtn.click()
  await page.waitForTimeout(600)
  check('提交后表单清空名称', (await nameInput.inputValue()) === '', await nameInput.inputValue())
  await switchTab(page, '仓库')
  await page.waitForTimeout(400)
  check('仓库页物品数 5 → 6', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  const newRow = await warehouseRow(page, '排针 2.54mm')
  check('新物品库存 = 300，单位 = 排', newRow?.[1] === '300' && newRow?.[2] === '排', newRow?.join(' / '))
  await shot(page, '5-new-item')

  // 6d 已有物品累加
  const before = await warehouseRow(page, '铜线 1.5mm²')
  check('铜线当前库存 -15（负数高亮）', before?.[1] === '-15', before?.[1])
  await switchTab(page, '操作')
  await page.waitForTimeout(300)
  await nameInput.fill('铜线 1.5mm²')
  await qtyInput.fill('45')
  await page.waitForTimeout(200)
  await submitBtn.click()
  await page.waitForTimeout(600)
  await switchTab(page, '仓库')
  await page.waitForTimeout(400)
  const after = await warehouseRow(page, '铜线 1.5mm²')
  check('入库 45 后铜线库存 -15 → 30（跨页自动刷新）', after?.[1] === '30', after?.[1])

  // ── 7. 撤销反向冲销 ──────────────────────────────────────
  // 上一节提交了两笔（排针新建 + 铜线入库 45），所以 9 → 11
  section('7. 撤销记录（反向冲销）')
  await switchTab(page, '记录')
  await page.waitForTimeout(400)
  check('记录数 9 → 11（上一节新增两笔）', (await rowCount(page)) === 11, `${await rowCount(page)}`)
  const firstRow = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr td')].slice(0, 6).map((td) => td.textContent.trim())
  )
  check('最新一条是刚提交的铜线入库 45', firstRow[1] === '铜线 1.5mm²' && firstRow[2] === '45' && firstRow[5] === '入库', firstRow.join(' / '))

  await page.evaluate(() => {
    ;[...document.querySelectorAll('tbody tr')][0].querySelector('button').click()
  })
  await page.waitForTimeout(800)
  check('弹出确认框', dialogs.some((d) => d.message.includes('确定撤销这条记录')), JSON.stringify(dialogs.at(-1) ?? {}))
  check('确认框写明了记录内容与操作人', dialogs.at(-1)?.message.includes('铜线 1.5mm²') === true, dialogs.at(-1)?.message.replace(/\s+/g, ' '))
  check('记录数回到 10（只撤销掉那一条）', (await rowCount(page)) === 10, `${await rowCount(page)}`)
  await switchTab(page, '仓库')
  await page.waitForTimeout(400)
  const undone = await warehouseRow(page, '铜线 1.5mm²')
  check('铜线库存 30 → -15（撤销反向冲销）', undone?.[1] === '-15', undone?.[1])
  await shot(page, '6-after-undo')

  // ── 8. 控制台 ────────────────────────────────────────────
  section('8. 渲染进程控制台')
  check('无 console.error / pageerror', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
}

// ── 入口 ────────────────────────────────────────────────────
let server = null
let browser = null
let exitCode = 1

try {
  // 构建产物比源码旧的话，测的就不是当前代码 —— 这种情况必须说出来
  const built = await stat(join(ROOT, 'out', 'renderer', 'index.html'))
  const srcNewest = await newestMtime(join(ROOT, 'src'))
  if (srcNewest > built.mtimeMs) {
    console.log('\n  ⚠️  src/ 比构建产物新，测的可能是旧代码。先跑 npm run build。\n')
  }

  if (WANT_SHOTS) await mkdir(SHOT_DIR, { recursive: true })
  const shot = async (page, name) => {
    if (!WANT_SHOTS) return
    await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false })
  }

  server = await startServer()
  browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1180, height: 800 },
    deviceScaleFactor: WANT_SHOTS ? 2 : 1
  })

  await run(page, shot)

  console.log(`\n${'─'.repeat(56)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  \u2717 ${f}`)
  }
  if (WANT_SHOTS) console.log(`\n截图目录：${SHOT_DIR}`)
  exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('\n自检中断：', err)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server) server.kill()
}

process.exit(exitCode)
