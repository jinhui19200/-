#!/usr/bin/env node
/**
 * 打包产物自检：从 DMG 挂载卷（或 dist/mac* 的 .app）真启动打包好的应用，
 * 用 CDP 连上真实窗口，验证报表页。
 *
 * 这是**唯一**一层在「打包后的东西」上跑的验证 —— 另外三层跑的都是 out/。
 * 它挖出过一个前三层都看不见的真问题：electron-builder 的 files 是黑名单，
 * 结果 1.6MB 验证截图、39KB 内部工作笔记、scripts/、preview/ 全被打进了 asar。
 *
 * 用法：
 *   npm run verify:packaged -- "/Volumes/库存管理系统 1.2.0"
 *   npm run verify:packaged -- dist/mac-arm64
 *   npm run verify:packaged -- "<路径>" [端口]
 *
 * 前置：先 `electron-builder --mac --dir`，或挂上 DMG。
 *
 * 为什么先往磁盘里铺一段历史数据，而不是全靠界面录入：
 *   操作页没有时间输入框，所有界面录入的记录时间都是「现在」。
 *   于是全新 userData 里所有记录都落在当月 → maxOffset = 0 →
 *   平移被钳制锁死，「更早」按钮禁用、区间纹丝不动。
 *   那是**正确行为**，但会让一整组平移断言在「无事发生」的状态下通过，
 *   等于没测。铺 15 个月的历史，平移路径才真的被走到。
 *   界面录入仍然保留，用来证明 IPC 写入这条链路是通的。
 *
 * 环境变量 SEED_MONTHS=1 可以只铺当月数据，用来做**反向验证**：
 * 那时平移整组断言必须变红，能变红才证明它们不是空跑。
 *
 * 四个容易写错、导致「假通过」的地方，已刻意规避：
 *   1. 读 getAttribute('src') 只能拿到相对路径 './assets/…'，恒不匹配 app.asar，要读解析后的 el.src
 *   2. 全新 userData 里仓库是空的，报表页走空状态分支，几何断言会在空集上「通过」——必须先造数据
 *   3. 按月份定位柱子，不要按下标（窗口月数一改下标全错位）
 *   4. 出入库要落在**同一张卡**上，否则去没有出库记录的卡上找出库柱，只会得到空集
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const VOLUME = process.argv[2]
if (!VOLUME) {
  console.error('用法: node scripts/.verify-packaged-app.mjs "<挂载卷路径>" [端口]')
  process.exit(2)
}
const CDP_PORT = Number(process.argv[3] ?? 9241)
const ENDPOINT = `http://127.0.0.1:${CDP_PORT}`
const BIN = join(VOLUME, '库存管理系统.app', 'Contents', 'MacOS', '库存管理系统')

const SEED_ITEM = 'M3×8 螺丝'
const UI_ITEM = '贴片电阻 10kΩ'
/**
 * 比窗口多 3 个月，保证「窗口外还有记录」这条提示也有内容。
 *
 * 可以被 `SEED_MONTHS=1` 覆盖 —— 那是用来做**反向验证**的：
 * 只铺当月数据时 maxOffset 归零，平移整组断言应当立刻变红。
 * 能变红才证明它们不是「无事发生所以没错」的空跑。
 */
const HISTORY_MONTHS = Number(process.env.SEED_MONTHS ?? 15)
const WINDOW = 12
const PX_PER_MONTH = 60 // 与 ReportsPage.tsx 保持一致

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + label + (detail ? ' \u2014 ' + detail : ''))
  if (ok) passed++
  else failed++
}

const now = new Date()
const mkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const anchorFor = (off) => new Date(now.getFullYear(), now.getMonth() - off, 1)
/** 平移 off 个月后，界面上应当显示的统计区间（`YYYY-MM ~ YYYY-MM`） */
const rangeFor = (off) => {
  const a = anchorFor(off)
  const first = new Date(a.getFullYear(), a.getMonth() - (WINDOW - 1), 1)
  return `${mkey(first)} ~ ${mkey(a)}`
}

/** 铺到磁盘上的历史月份，从旧到新 */
const months = []
for (let k = HISTORY_MONTHS - 1; k >= 0; k--) months.push(mkey(anchorFor(k)))
const maxOffset = HISTORY_MONTHS - 1

/** 造一份种子库：每个历史月各一笔入库、一笔出库，都挂在同一个物品上 */
function seedDb() {
  const stamp = '2026-01-01T00:00:00.000Z'
  const records = []
  months.forEach((m, i) => {
    const common = { itemId: 'i1', name: SEED_ITEM, unit: '个' }
    records.push({
      id: `r-in-${i}`, ...common, time: `${m}-10T09:00`,
      quantity: 100 + i * 10, type: 'in', operator: '张三', createdAt: stamp
    })
    records.push({
      id: `r-out-${i}`, ...common, time: `${m}-20T15:00`,
      quantity: 40 + i * 5, type: 'out', operator: '李四', createdAt: stamp
    })
  })
  const totalIn = records.filter((r) => r.type === 'in').reduce((s, r) => s + r.quantity, 0)
  const totalOut = records.filter((r) => r.type === 'out').reduce((s, r) => s + r.quantity, 0)
  return {
    version: 1,
    items: [
      {
        id: 'i1', name: SEED_ITEM, unit: '个', quantity: totalIn - totalOut, threshold: 100,
        createdAt: stamp, updatedAt: stamp
      }
    ],
    records
  }
}

async function switchTab(page, t) {
  await page.evaluate((name) => {
    const b = [...document.querySelectorAll('button.tab')].find((x) => x.textContent.trim() === name)
    if (b) b.click()
  }, t)
  await sleep(350)
}

async function submitViaUi(page, { type = 'in', name, quantity, unit, operator }) {
  await switchTab(page, '操作')
  const form = page.locator('.tx-form').nth(type === 'out' ? 1 : 0)
  await form.locator('input[type="text"]').nth(0).fill(name)
  await sleep(150)
  await form.locator('input[type="number"]').fill(String(quantity))
  const unitInput = form.locator('input[type="text"]').nth(1)
  if ((await unitInput.getAttribute('readonly')) === null) await unitInput.fill(unit)
  if (operator) await form.locator('input[type="text"]').nth(2).fill(operator)
  await sleep(150)
  await form.locator('button[type="submit"]').click()
  await sleep(700)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'wm-pkg-'))
await writeFile(join(userDataDir, 'data.json'), JSON.stringify(seedDb(), null, 2), 'utf8')

const child = spawn(BIN, [
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox', '--disable-software-rasterizer',
  '--window-position=-3000,-3000'
], { env: { ...process.env, NODE_OPTIONS: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })

let log = ''
child.stdout.on('data', (d) => (log += String(d)))
child.stderr.on('data', (d) => (log += String(d)))

let browser
try {
  let up = false
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try { if ((await fetch(`${ENDPOINT}/json/version`)).ok) { up = true; break } } catch { /* 等 */ }
    await sleep(400)
  }
  check('app 真的启动了（调试端口就绪）', up, up ? '' : log.slice(-400))
  if (!up) throw new Error('启动失败')

  browser = await chromium.connectOverCDP(ENDPOINT)
  const ctx = browser.contexts()[0]
  const dl = Date.now() + 20000
  while (ctx.pages().length === 0 && Date.now() < dl) await sleep(200)
  const page = ctx.pages()[0]
  if (!page) throw new Error('没有窗口')

  await page.waitForSelector('.tab')
  check('窗口渲染出界面（preload 链路通）', true)

  const resolvedSrc = await page.$eval('script[type=module]', (s) => s.src)
  check('渲染资源来自 app.asar', /app\.asar/.test(resolvedSrc), resolvedSrc.replace(/^file:\/\//, '').slice(-58))

  // ---- 走界面造数据（证明 IPC 写入链路通）----
  await switchTab(page, '仓库')
  check('启动即读到磁盘里的种子物品', (await page.$$eval('tbody tr', (rs) => rs.length)) === 1,
    String(await page.$$eval('tbody tr', (rs) => rs.length)) + ' 行')

  await submitViaUi(page, { type: 'in', name: SEED_ITEM, quantity: 300, unit: '个', operator: '张三' })
  await submitViaUi(page, { type: 'in', name: UI_ITEM, quantity: 500, unit: '个', operator: '李四' })
  await submitViaUi(page, { type: 'out', name: UI_ITEM, quantity: 200, unit: '个', operator: '王五' })

  await switchTab(page, '仓库')
  check('界面录入后仓库有 2 个物品', (await page.$$eval('tbody tr', (rs) => rs.length)) === 2)

  // ---- 报表页 ----
  await switchTab(page, '报表')
  await page.waitForSelector('.report-card', { timeout: 10000 })

  const readCard = (name) =>
    page.evaluate((n) => {
      const el = [...document.querySelectorAll('.report-card')].find(
        (c) => c.querySelector('.report-name')?.textContent?.trim() === n
      )
      if (!el) return null
      const axis = el.querySelector('.plot-axis').getBoundingClientRect()
      const read = (sel) =>
        [...el.querySelectorAll(sel)].map((b) => {
          const r = b.getBoundingClientRect()
          const lab = b.querySelector('.plot-value')
          const lr = lab ? lab.getBoundingClientRect() : null
          return {
            h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom),
            value: lab ? lab.textContent.trim() : null,
            labTop: lr ? Math.round(lr.top) : null,
            labBottom: lr ? Math.round(lr.bottom) : null
          }
        })
      return {
        months: [...el.querySelectorAll('.plot-label')].map((e) => e.getAttribute('title')),
        axisTop: Math.round(axis.top), axisBottom: Math.round(axis.bottom),
        halfH: Math.round(el.querySelector('.plot-in').getBoundingClientRect().height),
        scaleMax: Number(el.querySelector('.plot-gutter-in span')?.textContent?.trim()),
        barsIn: read('.plot-in .plot-bar'),
        barsOut: read('.plot-out .plot-bar')
      }
    }, name)

  const barAt = (c, month, dir) => {
    if (!c) return null
    const i = c.months.indexOf(month)
    return i < 0 ? null : (dir === 'in' ? c.barsIn[i] : c.barsOut[i])
  }

  const card = await readCard(SEED_ITEM)
  check(`找到「${SEED_ITEM}」的图表`, card !== null)
  check(`默认窗口是最近 ${WINDOW} 个月`, card?.months.length === WINDOW, String(card?.months.length))
  check('默认窗口区间正确', card?.months[0] === rangeFor(0).slice(0, 7) && card?.months[WINDOW - 1] === rangeFor(0).slice(-7),
    `${card?.months[0]} ~ ${card?.months[WINDOW - 1]}，期望 ${rangeFor(0)}`)

  const nonZeroIn = card.barsIn.filter((b) => b.h > 0)
  const nonZeroOut = card.barsOut.filter((b) => b.h > 0)
  check('12 个月每月都有非零入库柱', nonZeroIn.length === WINDOW, `${nonZeroIn.length} 根`)
  check('12 个月每月都有非零出库柱', nonZeroOut.length === WINDOW, `${nonZeroOut.length} 根`)
  check('入库柱全在零轴上方', nonZeroIn.every((b) => b.bottom <= card.axisTop + 1))
  check('出库柱全在零轴下方', nonZeroOut.every((b) => b.top >= card.axisBottom - 1))

  // 标注
  const inLab = card.barsIn.filter((b) => b.labTop !== null)
  const outLab = card.barsOut.filter((b) => b.labBottom !== null)
  check('入库柱全部带数值标注', inLab.length === WINDOW, `${inLab.length} 根`)
  check('出库柱全部带数值标注', outLab.length === WINDOW, `${outLab.length} 根`)
  check('入库柱标注在柱子正上方', inLab.every((b) => b.labBottom <= b.top + 1))
  check('出库柱标注在柱子正下方', outLab.every((b) => b.labTop >= b.bottom - 1))

  const bad = []
  for (const b of [...card.barsIn, ...card.barsOut]) {
    if (b.value === null) continue
    const want = Math.max(2, (Number(b.value) / card.scaleMax) * card.halfH)
    if (Math.abs(b.h - want) > 2) bad.push([b.value, b.h, Math.round(want)])
  }
  check('每根带标注的柱子都与自身数值成比例', bad.length === 0,
    bad.length ? JSON.stringify(bad) : `${inLab.length + outLab.length} 根吻合（刻度 ${card.scaleMax}）`)

  // ---- 12 个月窗口平移 ----
  const rangeText = () => page.$eval('.report-range', (e) => e.textContent.trim().replace(/^统计区间：/, ''))
  const noteText = () =>
    page.$$eval('.report-note', (els) => (els[0] ? els[0].textContent.trim() : null))
  const btnDisabled = (label) =>
    page.evaluate((t) => {
      const b = [...document.querySelectorAll('.range-btn')].find((x) => x.textContent.trim() === t)
      return b ? b.disabled : null
    }, label)
  const clickBtn = async (label) => {
    await page.evaluate((t) => {
      const b = [...document.querySelectorAll('.range-btn')].find((x) => x.textContent.trim() === t)
      if (b) b.click()
    }, label)
    await sleep(250)
  }

  // 先确认「有历史可回看」。少了这一条，后面所有平移断言都会在
  // maxOffset = 0 的状态下「通过」——因为什么都没发生，也就没出错。
  check('「更早」按钮可用（确有历史可回看）', (await btnDisabled('◀ 更早')) === false, await rangeText())
  check('「更晚」按钮默认禁用（不能滑向未来）', (await btnDisabled('更晚 ▶')) === true)
  check('默认区间 = 最近 12 个月', (await rangeText()) === rangeFor(0), await rangeText())
  check('提示窗口外还有 3 个月的记录', (await noteText()) === '窗口外还有 3 个月的记录', String(await noteText()))

  await clickBtn('◀ 更早')
  check('点「更早」区间整体前移一个月', (await rangeText()) === rangeFor(1), `${rangeFor(0)} → ${await rangeText()}`)
  check('前移后「更晚」变可用', (await btnDisabled('更晚 ▶')) === false)
  check('前移后出现「回到最新」', (await btnDisabled('回到最新')) === false)

  for (let i = 0; i < maxOffset; i++) await clickBtn('◀ 更早')
  // 详情串里的 rangeText() 必须 await：漏了会打出 `[object Promise]`，
  // 判定照样是对的，但这条断言一旦变红就没法从输出看出实际停在哪 —— 等于白红。
  //
  // 条件里带上 `maxOffset > 0`：maxOffset 为 0 时循环一次没跑，
  // 「停在 rangeFor(maxOffset)」和「停在默认位置」是同一件事，
  // 这条断言就会在「压根没平移」的状态下变绿。把前提写进条件里才自足。
  const stoppedAt = await rangeText()
  check(`一直前移到最早记录处停住（第 ${maxOffset} 个月）`, maxOffset > 0 && stoppedAt === rangeFor(maxOffset),
    `${stoppedAt}，期望 ${rangeFor(maxOffset)}`)
  check('到最早处「更早」自动禁用', maxOffset > 0 && (await btnDisabled('◀ 更早')) === true,
    maxOffset > 0 ? '' : 'maxOffset 为 0，这条无从验证')
  const atStop = await readCard(SEED_ITEM)
  check(`滑到最早处，${months[0]} 的记录仍在窗口内`,
    (barAt(atStop, months[0], 'in')?.h ?? 0) > 0, `${months[0]} 入库柱高 ${barAt(atStop, months[0], 'in')?.h}`)
  check('滑到最早处，当月已滑出窗口', !atStop.months.includes(months[HISTORY_MONTHS - 1]),
    atStop.months.join(' '))

  await clickBtn('回到最新')
  check('「回到最新」复位到默认区间', (await rangeText()) === rangeFor(0), await rangeText())
  check('复位后「回到最新」按钮消失', (await btnDisabled('回到最新')) === null)

  // 拖动平移：往右拖 = 把时间轴往右拉 = 看到更早的数据
  const dragBy = async (px) => {
    const gb = await page.$eval('.report-grid', (el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 40) }
    })
    await page.mouse.move(gb.x, gb.y)
    await page.mouse.down()
    await page.mouse.move(gb.x + px, gb.y, { steps: 8 })
    await page.mouse.up()
    await sleep(300)
  }
  const wantDrag = Math.round(130 / PX_PER_MONTH)
  await dragBy(130)
  check(`往右拖 130px 前移 ${wantDrag} 个月`, (await rangeText()) === rangeFor(wantDrag),
    `${rangeFor(0)} → ${await rangeText()}，期望 ${rangeFor(wantDrag)}`)
  await dragBy(-130)
  check('往回拖回到默认区间', (await rangeText()) === rangeFor(0), await rangeText())

  const legend = await page.$$eval('.legend', (els) => els.map((e) => e.textContent.trim()))
  check('图例两项', legend.length === 2, legend.join(' | '))

  console.log('\n  首张卡标注（月份从旧到新）：')
  console.log('    入库 ' + card.barsIn.map((b) => b.value ?? '·').join(', '))
  console.log('    出库 ' + card.barsOut.map((b) => b.value ?? '·').join(', '))
} catch (e) {
  check('执行过程无异常', false, String(e).slice(0, 300))
} finally {
  try { await browser?.close() } catch { /* 忽略 */ }
  child.kill('SIGKILL')
  await sleep(500)
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed}/${passed + failed} 通过`)
process.exit(failed === 0 ? 0 : 1)
