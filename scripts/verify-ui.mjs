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

/**
 * 仓库页某个物品所在行，返回 `{ 表头名: 单元格值 }`。
 *
 * 刻意不用下标取值：加一列就会让所有下标**静默错位**。
 * 新增「警戒值」列时就是这样让 4 处断言同时失效的，
 * 而且报出来的是「值不对」，看不出根因是列错位，排查很费时间。
 *
 * 表头名本身也会随内容变化（「本月入库（9月）」带月份、「单位（已锁定）」带锁定标记），
 * 所以统一去掉括号内容作为规范名。
 *
 * 注意：读取逻辑必须在 page.evaluate 内部重新写一遍 —— 这个文件跑在 Node 里，
 * 定义在模块顶层的函数进不了页面上下文。
 */
const warehouseRow = (page, name) =>
  page.evaluate((n) => {
    const read = (row) => {
      const ths = [...row.closest('table').querySelectorAll('thead th')]
      const out = {}
      ths.forEach((th, i) => {
        const key = th.textContent.trim().replace(/（[^）]*）|\([^)]*\)/g, '').trim()
        const td = row.querySelectorAll('td')[i]
        if (!td) return
        // 单元格里可能是 <input>（如警戒值），它的 textContent 恒为空串，必须读 .value
        const input = td.querySelector('input')
        out[key] = input ? input.value : td.textContent.trim()
      })
      return out
    }
    const tr = [...document.querySelectorAll('tbody tr')].find(
      (r) => r.querySelector('td')?.textContent?.trim() === n
    )
    return tr ? read(tr) : null
  }, name)

/** 把 { 表头名: 值 } 打成一行，失败信息里能看清到底取到了什么 */
const rowText = (row) =>
  row ? Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' / ') : '(没有这一行)'

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
  check('四个页签：仓库 / 记录 / 报表 / 操作', tabs.join('|') === '仓库|记录|报表|操作', tabs.join('|'))
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
  const numeric = cols.filter(
    (c) => c.head === '数量' || c.head === '警戒值' || c.head.startsWith('本月')
  )
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

  // ── 2b. 警戒值 ───────────────────────────────────────────
  section('2b. 仓库页：警戒值')

  /** 仓库页某物品「数量」单元格的样式与文本 */
  const qtyCell = (page, name) =>
    page.evaluate((n) => {
      const tr = [...document.querySelectorAll('tbody tr')].find(
        (r) => r.querySelector('td')?.textContent?.trim() === n
      )
      if (!tr) return null
      // 按表头名定位「数量」列，不按下标 —— 加列时下标会静默错位
      const ths = [...tr.closest('table').querySelectorAll('thead th')]
      const i = ths.findIndex((th) => th.textContent.trim() === '数量')
      if (i < 0) throw new Error('仓库表里找不到「数量」列')
      const td = tr.querySelectorAll('td')[i]
      const cs = getComputedStyle(td)
      return {
        text: td.textContent.trim(),
        bg: cs.backgroundColor,
        color: cs.color,
        weight: cs.fontWeight,
        low: td.classList.contains('below-threshold'),
        negative: td.classList.contains('negative')
      }
    }, name)

  const thresholdValue = (page, name) =>
    page.evaluate((n) => {
      const tr = [...document.querySelectorAll('tbody tr')].find(
        (r) => r.querySelector('td')?.textContent?.trim() === n
      )
      return tr ? tr.querySelector('.threshold-input').value : null
    }, name)

  /** 改警戒值：走真实输入 + 失焦（提交发生在 onBlur） */
  const setThreshold = async (page, name, value) => {
    await page.evaluate(
      ([n, v]) => {
        const tr = [...document.querySelectorAll('tbody tr')].find(
          (r) => r.querySelector('td')?.textContent?.trim() === n
        )
        const input = tr.querySelector('.threshold-input')
        input.focus()
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, String(v))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.blur()
      },
      [name, value]
    )
    await page.waitForTimeout(350)
  }

  const lowRows = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')]
        .filter((r) => r.querySelector('td.below-threshold'))
        .map((r) => r.querySelector('td')?.textContent?.trim())
    )

  check(
    '表头含「警戒值」列，且在「单位」之后',
    cols.map((c) => c.head).join('|') === '名称|数量|单位|警戒值|本月入库（9月）|本月出库（9月）|操作',
    cols.map((c) => c.head).join('|')
  )
  check('警戒值列是数值列（右对齐）', cols[3].rightAligned, cols[3].hAlign)

  // 种子里的警戒值：螺丝 100 / 电阻 100 / 铜线 50 / 焊锡丝 10 / PCB 5
  check('螺丝警戒值显示 100', (await thresholdValue(page, 'M3×8 螺丝')) === '100', await thresholdValue(page, 'M3×8 螺丝'))
  check('铜线警戒值显示 50', (await thresholdValue(page, '铜线 1.5mm²')) === '50', await thresholdValue(page, '铜线 1.5mm²'))

  // 种子状态：245/100 不低、80/100 低、-15/50 低、12/10 不低、0/5 低 → 3 种
  const low0 = await lowRows(page)
  check(
    '低于警戒值的行共 3 种（电阻 / 铜线 / PCB）',
    low0.length === 3,
    low0.join('、')
  )
  check(
    '螺丝 245 ≥ 100，不标红',
    (await qtyCell(page, 'M3×8 螺丝')).low === false
  )
  const dianceCell = await qtyCell(page, '贴片电阻 10kΩ')
  check('电阻 80 < 100，数量单元格标红', dianceCell.low === true)
  check(
    '标红单元格底色是浅红',
    dianceCell.bg === 'rgb(253, 236, 235)',
    dianceCell.bg
  )
  check(
    '标红单元格数字加粗',
    Number(dianceCell.weight) >= 600,
    dianceCell.weight
  )
  const copperCell = await qtyCell(page, '铜线 1.5mm²')
  check(
    '负库存同时带 negative 与 below-threshold 两个类',
    copperCell.negative === true && copperCell.low === true,
    `negative=${copperCell.negative} low=${copperCell.low}`
  )
  check(
    '顶部显示「3 种低于警戒值」',
    (await page.evaluate(() => document.querySelector('.count-warn')?.textContent?.trim() ?? '')).includes('3 种低于警戒值'),
    await page.evaluate(() => document.querySelector('.count-warn')?.textContent?.trim() ?? '(无)')
  )
  await shot(page, '2b-threshold')

  // 改警戒值：把螺丝从 100 提到 300 → 245 < 300，应立刻变红
  await setThreshold(page, 'M3×8 螺丝', 300)
  check('改警戒值后输入框显示 300', (await thresholdValue(page, 'M3×8 螺丝')) === '300', await thresholdValue(page, 'M3×8 螺丝'))
  check('螺丝 245 < 300，数量变红', (await qtyCell(page, 'M3×8 螺丝')).low === true)
  check('低于警戒值数量变为 4 种', (await lowRows(page)).length === 4, `${(await lowRows(page)).length}`)
  await shot(page, '2b-threshold-changed')

  // 调低回去：螺丝警戒值设 1 → 245 ≥ 1，红应消失
  await setThreshold(page, 'M3×8 螺丝', 1)
  check('警戒值调回 1 后螺丝不再标红', (await qtyCell(page, 'M3×8 螺丝')).low === false)
  check('低于警戒值数量回到 3 种', (await lowRows(page)).length === 3, `${(await lowRows(page)).length}`)

  // 非法输入：清空 → 失焦后回到「上一次生效的值」，不把空值写进数据。
  // 这里刻意不做「清空 = 恢复默认 100」：用户清空多半是想取消这次修改，
  // 静默把它改成 100 等于替用户改了数据。（数据层仍有 100 兜底，防直接调 IPC）
  await setThreshold(page, 'M3×8 螺丝', '')
  check(
    '清空后失焦：回到上一次生效的值 1，不写空值',
    (await thresholdValue(page, 'M3×8 螺丝')) === '1',
    await thresholdValue(page, 'M3×8 螺丝')
  )
  check('清空没有改变低于警戒值的判定（245 ≥ 1）', (await qtyCell(page, 'M3×8 螺丝')).low === false)

  // 负数输入同理：不写进数据，回到原值
  await setThreshold(page, '焊锡丝 0.8mm', -3)
  check(
    '负数输入失焦后回到 10，不写负数',
    (await thresholdValue(page, '焊锡丝 0.8mm')) === '10',
    await thresholdValue(page, '焊锡丝 0.8mm')
  )
  check('焊锡丝 12 ≥ 10，不标红', (await qtyCell(page, '焊锡丝 0.8mm')).low === false)

  // 非数字输入（type=number 在真实浏览器里会挡掉字母，用超长数值模拟非法）
  await setThreshold(page, 'M3×8 螺丝', '1e999')
  check(
    '溢出数值（Infinity）失焦后回到原值',
    (await thresholdValue(page, 'M3×8 螺丝')) === '1',
    await thresholdValue(page, 'M3×8 螺丝')
  )

  // 恢复种子状态，避免影响后续用例
  await setThreshold(page, 'M3×8 螺丝', 100)
  check('螺丝警戒值恢复 100', (await thresholdValue(page, 'M3×8 螺丝')) === '100', await thresholdValue(page, 'M3×8 螺丝'))

  // 改警戒值不该产生流水
  const recordsAfterThreshold = await page.evaluate(async () => {
    const snap = await window.api.getSnapshot()
    return snap.records.length
  })
  check('改警戒值没有写进出库记录', recordsAfterThreshold === 17, `${recordsAfterThreshold}`)

  // 数据层确实存下了新警戒值（不是只改了界面）
  const persisted = await page.evaluate(async () => {
    const snap = await window.api.getSnapshot()
    return snap.items.map((i) => `${i.name}:${i.threshold}`).join(' ')
  })
  check(
    '快照里警戒值与界面一致',
    persisted.includes('M3×8 螺丝:100') && persisted.includes('铜线 1.5mm²:50'),
    persisted
  )

  // ── 2c. 报表页：双向柱状图 ───────────────────────────────
  section('2c. 报表页：入库在上 / 出库在下')
  await switchTab(page, '报表')
  await page.waitForTimeout(400)

  /** 某物品卡片的图表几何。柱高只量高度，位置用来判断在零轴哪一侧 */
  const reportCard = (name) =>
    page.evaluate((n) => {
      const card = [...document.querySelectorAll('.report-card')].find(
        (c) => c.querySelector('.report-name')?.textContent?.trim() === n
      )
      if (!card) return null
      const box = (el) => {
        const r = el.getBoundingClientRect()
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          h: Math.round(r.height)
        }
      }
      const readBars = (sel) =>
        [...card.querySelectorAll(sel)].map((b) => ({ ...box(b), title: b.getAttribute('title') }))
      return {
        labels: [...card.querySelectorAll('.plot-label')].map((e) => e.textContent.trim()),
        // 两个刻度列各自的两个标签：[上半: 最大值, 0] / [下半: 0, 最大值]
        gutters: [...card.querySelectorAll('.plot-gutter')].map((g) =>
          [...g.querySelectorAll('span')].map((s) => s.textContent.trim())
        ),
        axis: box(card.querySelector('.plot-axis')),
        barsIn: readBars('.plot-in .plot-bar'),
        barsOut: readBars('.plot-out .plot-bar')
      }
    }, name)

  const cardCount = await page.evaluate(() => document.querySelectorAll('.report-card').length)
  check('仓库里每个物品一张卡片（5 个物品 → 5 张）', cardCount === 5, `${cardCount}`)

  const card = await reportCard('M3×8 螺丝')
  check('找到「M3×8 螺丝」的图表', card !== null)

  if (card) {
    check(
      '横轴是最近 6 个自然月',
      card.labels.join('|') === '4月|5月|6月|7月|8月|9月',
      card.labels.join('|')
    )

    // 上下两半若各自按自己的最大值缩放，柱子长度就不可比了 —— 必须共用同一刻度
    check(
      '上下两半共用同一刻度（最大值 300）',
      card.gutters[0][0] === '300' && card.gutters[1][1] === '300',
      JSON.stringify(card.gutters)
    )

    const inAbove = card.barsIn.filter((b) => b.h > 0).every((b) => b.bottom <= card.axis.top + 1)
    const outBelow = card.barsOut.filter((b) => b.h > 0).every((b) => b.top >= card.axis.bottom - 1)
    check('入库柱全部在零轴上方', inAbove, JSON.stringify(card.barsIn.map((b) => [b.h, b.bottom])))
    check('出库柱全部在零轴下方', outBelow, JSON.stringify(card.barsOut.map((b) => [b.h, b.top])))

    // 数值取自 title：顺带验证「按物品 + 按月聚合」算对了
    check('6 月入库 300', card.barsIn[2].title === '2026-06 入库 300', card.barsIn[2].title)
    check('7 月出库 150', card.barsOut[3].title === '2026-07 出库 150', card.barsOut[3].title)
    check('9 月入库 150（同月两笔 100+50 合并）', card.barsIn[5].title === '2026-09 入库 150', card.barsIn[5].title)
    check('9 月出库 20', card.barsOut[5].title === '2026-09 出库 20', card.barsOut[5].title)
    check(
      '没有数据的月份柱高为 0（不是留空不画）',
      card.barsIn[0].h === 0 && card.barsOut[0].h === 0,
      `${card.barsIn[0].h}/${card.barsOut[0].h}`
    )

    // 柱高与数值成比例：300 的柱应约为 150 的两倍（各留 3px 舍入误差）
    const h300 = card.barsIn[2].h
    const h150 = card.barsIn[5].h
    check(
      '柱高与数值成比例（300 的柱 ≈ 150 的两倍）',
      Math.abs(h300 - 2 * h150) <= 3,
      `300→${h300}px，150→${h150}px`
    )

    const totals = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.report-card')].find(
        (x) => x.querySelector('.report-name')?.textContent?.trim() === 'M3×8 螺丝'
      )
      if (!c) return null
      // 两个 <b> 之间没有空白节点，整块 textContent 会粘成「入 455出 170」，
      // 分别取元素比按整串比更稳
      return [...c.querySelectorAll('.report-total b')].map((b) => b.textContent.trim())
    })
    check(
      '卡片头部合计 = 入 455 / 出 170',
      totals?.join(' | ') === '入 455 | 出 170',
      JSON.stringify(totals)
    )
  }

  await shot(page, '2c-reports')
  await switchTab(page, '仓库')
  await page.waitForTimeout(300)

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
  check('记录页共 17 条种子数据', (await rowCount(page)) === 17, `${await rowCount(page)}`)
  await shot(page, '2-records')

  // ── 4. 名称 / 类型筛选 ───────────────────────────────────
  section('4. 名称与类型筛选')
  await setInput(page, '.search-input', '螺丝')
  await page.waitForTimeout(250)
  check('搜「螺丝」→ 6 条', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  await setInput(page, '.search-input', '')
  await page.waitForTimeout(250)

  // 种子 17 条的构成（先 grep 数过）：入库 11 条、出库 6 条
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.filter-group button')]
      .find((b) => b.textContent.trim() === '出库')
      .click()
  })
  await page.waitForTimeout(250)
  check('筛「出库」→ 6 条', (await rowCount(page)) === 6, `${await rowCount(page)}`)
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.filter-group button')]
      .find((b) => b.textContent.trim() === '全部')
      .click()
  })
  await page.waitForTimeout(250)

  // ── 5. 时间范围（含当日） ────────────────────────────────
  // 种子数据的日期分布（先用 grep 数过，别凭印象）：
  //   09-19 六条（08:00 / 09:30 / 10:00 / 11:00 / 13:00 / 15:00）
  //   09-18 一条、09-17 一条、08-20 一条；另有 6/7/8 月共 8 条，合计 17 条
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
    '标题显示「筛选出 6 / 共 17 条」',
    (await countLabel(page)).includes('筛选出 6 / 共 17 条'),
    await countLabel(page)
  )
  await shot(page, '3-date-single-day')

  await setRange('2026-09-17', '2026-09-19')
  check('09-17 ~ 09-19 → 8 条', (await rowCount(page)) === 8, `${await rowCount(page)}`)

  await setRange('', '2026-09-18')
  check('只填截止 09-18 → 11 条（该日及更早）', (await rowCount(page)) === 11, `${await rowCount(page)}`)

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
  check('清除后恢复 17 条', (await rowCount(page)) === 17, `${await rowCount(page)}`)

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
  check(
    '新物品库存 = 300，单位 = 排',
    newRow?.['数量'] === '300' && newRow?.['单位'] === '排',
    rowText(newRow)
  )
  await shot(page, '5-new-item')

  // 6d 已有物品累加
  const before = await warehouseRow(page, '铜线 1.5mm²')
  check('铜线当前库存 -15（负数高亮）', before?.['数量'] === '-15', rowText(before))
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
  check('入库 45 后铜线库存 -15 → 30（跨页自动刷新）', after?.['数量'] === '30', rowText(after))

  // ── 7. 撤销反向冲销 ──────────────────────────────────────
  // 上一节提交了两笔（排针新建 + 铜线入库 45），所以 17 → 19
  section('7. 撤销记录（反向冲销）')
  await switchTab(page, '记录')
  await page.waitForTimeout(400)
  check('记录数 17 → 19（上一节新增两笔）', (await rowCount(page)) === 19, `${await rowCount(page)}`)
  const firstRow = await page.evaluate(() => {
    const tr = document.querySelector('tbody tr')
    if (!tr) return null
    const ths = [...tr.closest('table').querySelectorAll('thead th')]
    const out = {}
    ths.forEach((th, i) => {
      const key = th.textContent.trim().replace(/（[^）]*）|\([^)]*\)/g, '').trim()
      const td = tr.querySelectorAll('td')[i]
      if (td) out[key] = td.textContent.trim()
    })
    return out
  })
  check(
    '最新一条是刚提交的铜线入库 45',
    firstRow?.['名称'] === '铜线 1.5mm²' &&
      firstRow?.['数量'] === '45' &&
      firstRow?.['类型'] === '入库',
    rowText(firstRow)
  )

  await page.evaluate(() => {
    ;[...document.querySelectorAll('tbody tr')][0].querySelector('button').click()
  })
  await page.waitForTimeout(800)
  check('弹出确认框', dialogs.some((d) => d.message.includes('确定撤销这条记录')), JSON.stringify(dialogs.at(-1) ?? {}))
  check('确认框写明了记录内容与操作人', dialogs.at(-1)?.message.includes('铜线 1.5mm²') === true, dialogs.at(-1)?.message.replace(/\s+/g, ' '))
  check('记录数回到 18（只撤销掉那一条）', (await rowCount(page)) === 18, `${await rowCount(page)}`)
  await switchTab(page, '仓库')
  await page.waitForTimeout(400)
  const undone = await warehouseRow(page, '铜线 1.5mm²')
  check('铜线库存 30 → -15（撤销反向冲销）', undone?.['数量'] === '-15', rowText(undone))
  await shot(page, '6-after-undo')

  // ── 8. 操作页表单的时间默认值 ────────────────────────────
  // 默认时间是**表单挂载那一刻**取的。停在操作页跨过零点，默认值就成了昨天的日期。
  // 这里用假时钟把「跨零点」造出来 —— 否则只能干等一天，等于没有覆盖。
  //
  // 刻意不用 page.reload()：重载会打断前面所有小节积累的状态，
  // 而且时钟冻结后 React 的调度可能不刷新。切页签同样能让表单重新挂载，
  // 且点击是离散事件，React 会同步 flush，不依赖定时器。
  section('8. 操作页表单时间默认值')

  await switchTab(page, '仓库') // 先离开操作页，确保表单处于卸载状态
  await page.waitForTimeout(200)
  await page.clock.install({ time: new Date('2026-09-19T23:58:00') })
  await switchTab(page, '操作')
  await page.waitForTimeout(400)

  // 变量名带 clock 前缀：本文件 run() 是单个大函数作用域，
  // 第 6 节已经声明过 inForm / nameInput / qtyInput，重名会直接语法报错。
  const clockForm = page.locator('.tx-form').first()
  const clockTime = clockForm.locator('input[type="datetime-local"]')
  const clockName = clockForm.locator('input[type="text"]').first()
  const clockQty = clockForm.locator('input[type="number"]')

  check(
    '表单挂载时默认时间就是当前时刻',
    (await clockTime.inputValue()) === '2026-09-19T23:58',
    await clockTime.inputValue()
  )

  await page.clock.fastForward(10 * 60 * 1000) // 时间前进 10 分钟，跨过零点

  await clockName.click() // 用户开始操作表单，但没碰时间框
  check(
    '跨零点后一操作表单，默认时间校准到次日',
    (await clockTime.inputValue()) === '2026-09-20T00:08',
    await clockTime.inputValue()
  )

  await clockTime.fill('2026-09-20T09:30') // 手动改时间 → 之后不该再被刷新覆盖
  await clockQty.click()
  check(
    '手动改过的时间不会被聚焦刷新覆盖',
    (await clockTime.inputValue()) === '2026-09-20T09:30',
    await clockTime.inputValue()
  )

  // ── 9. 控制台 ────────────────────────────────────────────
  section('9. 渲染进程控制台')
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
