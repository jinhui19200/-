/**
 * 数据层自检脚本。
 *
 * 覆盖：原子写入、事务原子性、单位锁定、名称归一化、负库存、浮点精度、
 * 撤销反向冲销、持久化重载、并发写、损坏恢复、操作人字段。
 *
 * 运行：npm run verify:store
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDataFilePath, getLoadReport, getSnapshot, initStore, load } from '../src/main/store/db'
import { applyTransaction, deleteRecord, setItemThreshold } from '../src/main/store/transactions'
import {
  DEFAULT_THRESHOLD,
  HANDLER_COLUMN,
  handlerLabel,
  matchesItemQuery,
  monthDiff,
  monthLabel,
  monthlySeries,
  pinMatches,
  recentMonths
} from '../src/shared/utils'

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  \u2713 ${label}`)
  } else {
    failed++
    failures.push(label + (detail ? ` \u2014 ${detail}` : ''))
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'wh-store-test-'))
  initStore(dir)
  await load()

  section('1. 入库自动创建物品')
  let r = await applyTransaction({
    time: '2026-09-19T10:00',
    name: 'M3螺丝',
    quantity: 100,
    unit: '个',
    operator: '张三',
    handler: '赵六',
    type: 'in'
  })
  check('入库成功', r.ok === true, r.ok ? '' : r.error)
  if (r.ok) {
    check('库存 = 100', r.item.quantity === 100, `实际 ${r.item.quantity}`)
    check('单位 = 个', r.item.unit === '个', `实际 ${r.item.unit}`)
    check('记录方向 = in', r.record.type === 'in')
    check('记录单位存的是快照', r.record.unit === '个')
    check('操作人快照 = 张三', r.record.operator === '张三')
    check('经手人快照 = 赵六', r.record.handler === '赵六', `实际 ${JSON.stringify(r.record.handler)}`)
  }

  section('2. 同一物品再次入库应累加')
  r = await applyTransaction({
    time: '2026-09-19T11:00',
    name: 'M3螺丝',
    quantity: 50,
    unit: '个',
    type: 'in'
  })
  check('库存累加 = 150', r.ok && r.item.quantity === 150, r.ok ? `实际 ${r.item.quantity}` : '')
  check('物品数仍为 1', getSnapshot().items.length === 1, `实际 ${getSnapshot().items.length}`)

  section('3. 单位锁定（数据层强制，防绕过界面）')
  r = await applyTransaction({
    time: '2026-09-19T11:30',
    name: 'M3螺丝',
    quantity: 10,
    unit: '盒',
    type: 'in'
  })
  check(
    '传入「盒」被忽略，仍是「个」',
    r.ok && r.item.unit === '个',
    r.ok ? `实际 ${r.item.unit}` : ''
  )
  check('库存 = 160', r.ok && r.item.quantity === 160, r.ok ? `实际 ${r.item.quantity}` : '')

  section('4. 名称归一化')
  r = await applyTransaction({
    time: '2026-09-19T12:00',
    name: '  M3螺丝  ',
    quantity: 5,
    unit: '个',
    type: 'in'
  })
  check('前后空格视为同一物品', getSnapshot().items.length === 1, `物品数 ${getSnapshot().items.length}`)
  check('库存 = 165', r.ok && r.item.quantity === 165, r.ok ? `实际 ${r.item.quantity}` : '')

  section('5. 出库')
  r = await applyTransaction({ time: '2026-09-19T13:00', name: 'M3螺丝', quantity: 20, type: 'out' })
  check('出库成功', r.ok === true, r.ok ? '' : r.error)
  check('库存 = 145', r.ok && r.item.quantity === 145, r.ok ? `实际 ${r.item.quantity}` : '')

  section('6. 出库超库存：警告但不阻断')
  r = await applyTransaction({ time: '2026-09-19T14:00', name: 'M3螺丝', quantity: 200, type: 'out' })
  check('超库存出库不被阻断', r.ok === true, r.ok ? '' : r.error)
  check('库存变负 = -55', r.ok && r.item.quantity === -55, r.ok ? `实际 ${r.item.quantity}` : '')
  check('返回负库存警告', r.ok && typeof r.warning === 'string' && r.warning.length > 0)

  section('7. 输入校验')
  check('空名称被拒绝', (await applyTransaction({ time: '', name: '', quantity: 1, type: 'in' })).ok === false)
  check('数量 0 被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: 0, type: 'in' })).ok === false)
  check('负数被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: -5, type: 'in' })).ok === false)
  check('非数字被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: NaN, type: 'in' })).ok === false)
  check('新物品不填单位被拒绝', (await applyTransaction({ time: '', name: '新东西', quantity: 5, type: 'in' })).ok === false)

  section('8. 浮点精度')
  await applyTransaction({ time: '', name: '电线', quantity: 0.1, unit: '米', type: 'in' })
  await applyTransaction({ time: '', name: '电线', quantity: 0.2, unit: '米', type: 'in' })
  const wire = getSnapshot().items.find((i) => i.name === '电线')
  check('0.1 + 0.2 = 0.3（不是 0.30000000000000004）', wire?.quantity === 0.3, `实际 ${wire?.quantity}`)

  section('9. 原子写入产物')
  const raw = await readFile(getDataFilePath(), 'utf8')
  let parsedOk = true
  try {
    JSON.parse(raw)
  } catch {
    parsedOk = false
  }
  check('data.json 是合法 JSON', parsedOk)
  check('data.json 非空', raw.length > 0, `${raw.length} 字节`)
  const bak = await stat(`${getDataFilePath()}.bak`)
    .then(() => true)
    .catch(() => false)
  check('保留了 .bak 备份', bak)

  section('10. 撤销记录反向冲销库存')
  const beforeQty = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  const inRec = getSnapshot().records.find((rec) => rec.type === 'in' && rec.name === 'M3螺丝')!
  const recCountBefore = getSnapshot().records.length
  const d = await deleteRecord(inRec.id)
  check('撤销成功', d.ok === true, d.ok ? '' : d.error)
  const afterQty = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  check(
    `撤销一条入库 ${inRec.quantity} → 库存减少 ${inRec.quantity}`,
    Math.abs(afterQty - (beforeQty - inRec.quantity)) < 1e-9,
    `${beforeQty} → ${afterQty}`
  )
  check('记录数减少 1', getSnapshot().records.length === recCountBefore - 1)
  check('撤销不存在的记录被拒绝', (await deleteRecord('不存在的id')).ok === false)

  section('11. 撤销出库记录应加回库存')
  const outRec = getSnapshot().records.find((rec) => rec.type === 'out')!
  const q0 = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  await deleteRecord(outRec.id)
  const q1 = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  check(
    `撤销一条出库 ${outRec.quantity} → 库存增加 ${outRec.quantity}`,
    Math.abs(q1 - (q0 + outRec.quantity)) < 1e-9,
    `${q0} → ${q1}`
  )

  section('12. 持久化：清缓存后从磁盘重载')
  const itemsBefore = getSnapshot().items.length
  const recordsBefore = getSnapshot().records.length
  initStore(dir)
  await load()
  check('物品数一致', getSnapshot().items.length === itemsBefore, `${getSnapshot().items.length} vs ${itemsBefore}`)
  check('记录数一致', getSnapshot().records.length === recordsBefore, `${getSnapshot().records.length} vs ${recordsBefore}`)

  section('13. 并发写入不丢数据')
  const baseRecords = getSnapshot().records.length
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      applyTransaction({ time: '', name: '并发件', quantity: 1, unit: '个', type: 'in' })
    )
  )
  check('20 笔并发全部成功', results.every((x) => x.ok), `成功 ${results.filter((x) => x.ok).length}/20`)
  check('记录数 +20', getSnapshot().records.length === baseRecords + 20, `实际 +${getSnapshot().records.length - baseRecords}`)
  const conc = getSnapshot().items.find((i) => i.name === '并发件')
  check('库存累加到 20（无覆盖丢失）', conc?.quantity === 20, `实际 ${conc?.quantity}`)

  section('14. 失败不污染内存')
  const qBefore = getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity
  const rcBefore = getSnapshot().records.length
  await applyTransaction({ time: '', name: '', quantity: 1, type: 'in' })
  check('被拒绝的操作没有改变库存', getSnapshot().items.find((i) => i.name === 'M3螺丝')!.quantity === qBefore)
  check('被拒绝的操作没有新增记录', getSnapshot().records.length === rcBefore)

  section('15. 损坏恢复：主文件坏掉时从 .bak 恢复')
  const target = getDataFilePath()
  const bakPath = `${target}.bak`
  const goodContent = await readFile(target, 'utf8')
  const goodBak = await readFile(bakPath, 'utf8')
  const bakParsed = JSON.parse(goodBak) as { items: unknown[]; records: unknown[] }

  // 把主文件写坏（模拟用户手工改坏 / 被截断）
  await writeFile(target, '这不是 JSON { 坏掉了')

  initStore(dir)
  let threw = false
  try {
    await load()
  } catch {
    threw = true
  }
  // 这是关键：恢复成功是正常路径，抛异常会让启动流程直接挂掉
  check('恢复成功时 load() 不抛异常', !threw)
  check('loadReport 标记为「已从备份恢复」', getLoadReport().recoveredFromBackup === true)

  const restoredRaw = await readFile(target, 'utf8')
  check(
    '恢复后 data.json 是合法 JSON',
    (() => {
      try {
        JSON.parse(restoredRaw)
        return true
      } catch {
        return false
      }
    })()
  )
  check(
    '恢复后物品数与备份一致',
    getSnapshot().items.length === bakParsed.items.length,
    `${getSnapshot().items.length} vs ${bakParsed.items.length}`
  )
  check(
    '恢复后记录数与备份一致',
    getSnapshot().records.length === bakParsed.records.length,
    `${getSnapshot().records.length} vs ${bakParsed.records.length}`
  )

  // 最容易踩的坑：恢复时若照常「把当前主文件拷成备份」，
  // 就会把损坏内容覆盖到唯一的好备份上，救命稻草当场作废
  const bakAfter = await readFile(bakPath, 'utf8')
  check('好备份没有被损坏的主文件覆盖', bakAfter === goodBak, `备份变成了 ${bakAfter.slice(0, 40)}…`)

  // 清理：把好的写回去，避免影响后续用例
  await writeFile(target, goodContent)

  section('16. 旧数据无 operator / handler 字段时自动补空串')
  const legacy = JSON.stringify({
    version: 1,
    items: [{ id: '1', name: ' legacy', unit: '个', quantity: 10, createdAt: 'x', updatedAt: 'x' }],
    records: [{ id: 'r1', itemId: '1', time: '2026-01-01T00:00', name: 'legacy', unit: '个', quantity: 5, type: 'in', createdAt: 'x' }]
  })
  const legacyDir = await mkdtemp(join(tmpdir(), 'wh-legacy-test-'))
  await writeFile(join(legacyDir, 'data.json'), legacy)
  initStore(legacyDir)
  await load()
  const legacyRec = getSnapshot().records[0]
  check('旧记录 operator 被补成空串', legacyRec.operator === '', `实际 ${JSON.stringify(legacyRec.operator)}`)
  // handler 是比 operator 更晚加的字段，同一批旧数据里两个都没有。
  // 不补齐的话，记录页那一列会渲染出 `undefined`、导出会写出空单元格。
  check(
    '旧记录 handler 也被补成空串',
    legacyRec.handler === '',
    `实际 ${JSON.stringify(legacyRec.handler)}`
  )
  // 警戒值是后加的功能，旧数据文件里没有这个字段
  const legacyItem = getSnapshot().items[0]
  check(
    '旧物品 threshold 被补成默认值 100',
    legacyItem.threshold === DEFAULT_THRESHOLD,
    `实际 ${JSON.stringify(legacyItem.threshold)}`
  )

  section('17. 警戒值')
  // 回到主测试目录
  initStore(dir)
  await load()
  const first = getSnapshot().items[0]
  check(
    '新物品默认警戒值 100',
    first.threshold === DEFAULT_THRESHOLD,
    `实际 ${first.threshold}`
  )

  const recordsBeforeThreshold = getSnapshot().records.length
  const set1 = await setItemThreshold(first.id, 7)
  check('改成 7 成功', set1.ok && set1.item.threshold === 7, JSON.stringify(set1))
  check(
    '改警戒值不写流水（记录数不变）',
    getSnapshot().records.length === recordsBeforeThreshold,
    `${getSnapshot().records.length} vs ${recordsBeforeThreshold}`
  )
  check(
    '内存快照同步',
    getSnapshot().items.find((i) => i.id === first.id)?.threshold === 7
  )

  // 落盘校验：重新从磁盘读一遍，而不是信内存
  const diskAfterSet = JSON.parse(await readFile(getDataFilePath(), 'utf8'))
  check(
    '警戒值已落盘',
    diskAfterSet.items.find((i: { id: string }) => i.id === first.id)?.threshold === 7
  )

  const set2 = await setItemThreshold(first.id, 250.5)
  check('小数保留（250.5）', set2.ok && set2.item.threshold === 250.5, JSON.stringify(set2))

  for (const [label, bad] of [
    ['空串', ''],
    ['纯空白', '   '],
    ['非数字', 'abc'],
    ['负数', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ] as const) {
    const res = await setItemThreshold(first.id, bad as unknown as number)
    check(
      `非法输入「${label}」回落默认值 100`,
      res.ok && res.item.threshold === DEFAULT_THRESHOLD,
      JSON.stringify(res)
    )
  }

  const missing = await setItemThreshold('不存在的-id', 10)
  check('物品不存在时返回错误', !missing.ok, JSON.stringify(missing))

  // 持久化：重启后（重新 load）警戒值还在
  const persistedDir = dir
  initStore(persistedDir)
  await load()
  check(
    '重新加载后警戒值仍为 100（上一轮非法输入的结果）',
    getSnapshot().items.find((i) => i.id === first.id)?.threshold === DEFAULT_THRESHOLD
  )

  // ── 18. 报表用的月度序列 ─────────────────────────────────
  section('18. 月度序列（报表页的数据源）')

  // 跨年是最容易写错的地方：自己算 `m - i` 会得到负数或 0 月
  const crossYear = recentMonths(6, new Date(2026, 1, 15)) // 2026-02-15
  check(
    '跨年回推 6 个月得到 2025-09 ~ 2026-02',
    crossYear.join(',') === '2025-09,2025-10,2025-11,2025-12,2026-01,2026-02',
    crossYear.join(',')
  )

  // 日期固定为 1 号，否则 3-31 回推会落到不存在的「2 月 31 日」
  const from31 = recentMonths(3, new Date(2026, 2, 31)) // 2026-03-31
  check(
    '从 31 号回推不会跳到不存在的日期',
    from31.join(',') === '2026-01,2026-02,2026-03',
    from31.join(',')
  )

  const months = recentMonths(3, new Date(2026, 8, 19)) // 2026-07 ~ 2026-09
  check('序列从早到晚，最后一项是当月', months[months.length - 1] === '2026-09', months.join(','))

  const series = monthlySeries(
    [
      { itemId: 'a', time: '2026-09-01T10:00', quantity: 100, type: 'in' },
      { itemId: 'a', time: '2026-09-20T10:00', quantity: 50, type: 'in' },
      { itemId: 'a', time: '2026-09-21T10:00', quantity: 30, type: 'out' },
      { itemId: 'a', time: '2026-08-05T10:00', quantity: 7, type: 'out' },
      { itemId: 'b', time: '2026-09-02T10:00', quantity: 999, type: 'in' },
      { itemId: 'a', time: '2020-01-01T10:00', quantity: 888, type: 'in' } // 落在窗口之外
    ],
    'a',
    months
  )
  check('返回定长数组，与传入月份一一对应', series.length === 3, `${series.length}`)
  check('同月多笔入库累加（100+50）', series[2].in === 150, `${series[2].in}`)
  check('同月出库单独统计', series[2].out === 30, `${series[2].out}`)
  check('其它月份的记录记在对应位置（8 月出库 7）', series[1].out === 7, `${series[1].out}`)
  check(
    '没有记录的月份补 0 而不是缺项',
    series[0].in === 0 && series[0].out === 0,
    JSON.stringify(series[0])
  )
  check('只统计指定物品（b 的 999 不计入）', series[2].in === 150, `${series[2].in}`)
  check('窗口之外的历史记录被忽略', series.every((r) => r.in !== 888), JSON.stringify(series))
  check(
    '月份短标签（9月 / 1月）',
    monthLabel('2026-09') === '9月' && monthLabel('2026-01') === '1月',
    monthLabel('2026-09')
  )

  section('19. 月份差（时间窗口平移用）')
  check('同年', monthDiff('2026-01', '2026-09') === 8, `${monthDiff('2026-01', '2026-09')}`)
  check('跨年', monthDiff('2025-10', '2026-09') === 11, `${monthDiff('2025-10', '2026-09')}`)
  check('正好一年 = 12', monthDiff('2025-09', '2026-09') === 12, `${monthDiff('2025-09', '2026-09')}`)
  check('跨年相邻月 = 1（不是 -11）', monthDiff('2025-12', '2026-01') === 1, `${monthDiff('2025-12', '2026-01')}`)
  check('同月 = 0', monthDiff('2026-09', '2026-09') === 0, `${monthDiff('2026-09', '2026-09')}`)
  check('反向为负（符号有意义）', monthDiff('2026-09', '2026-01') === -8, `${monthDiff('2026-09', '2026-01')}`)

  // 把两个函数对起来：平移 offset 个月之后，窗口起点应当正好比锚点早 (WINDOW-1) 个月。
  // 这条不通过就说明「滑动一个月」实际滑的不是一个月（跨年或月末借位出错）。
  const WINDOW = 12
  for (const off of [0, 1, 11, 12, 25]) {
    const anchor = new Date(2026, 8 - off, 1)
    const win = recentMonths(WINDOW, anchor)
    const anchorKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}`
    const span = monthDiff(win[0], win[win.length - 1])
    check(
      `窗口长度恒为 ${WINDOW} 个月（offset=${off}）`,
      win.length === WINDOW && span === WINDOW - 1 && win[win.length - 1] === anchorKey,
      `${win[0]} ~ ${win[win.length - 1]}，跨度 ${span}`
    )
  }

  section('20. 经手人 / 领取人（与操作人并存，互不覆盖）')
  initStore(dir)
  await load()
  const hIn = await applyTransaction({
    time: '2026-09-20T09:00',
    name: 'M3螺丝',
    quantity: 5,
    operator: '操作员甲',
    // 故意带两侧空白：数据层应当裁掉再存
    handler: '  经手人乙  ',
    type: 'in'
  })
  check(
    '入库：经手人与操作人各自存下，互不覆盖（且两侧空白被裁掉）',
    hIn.ok && hIn.record.handler === '经手人乙' && hIn.record.operator === '操作员甲',
    hIn.ok ? JSON.stringify({ h: hIn.record.handler, o: hIn.record.operator }) : hIn.error
  )
  const hOut = await applyTransaction({
    time: '2026-09-20T10:00',
    name: 'M3螺丝',
    quantity: 2,
    operator: '操作员甲',
    handler: '领取人丙',
    type: 'out'
  })
  check(
    '出库：同一个字段装领取人，方向不同而已',
    hOut.ok && hOut.record.handler === '领取人丙' && hOut.record.type === 'out',
    hOut.ok ? JSON.stringify(hOut.record.handler) : hOut.error
  )

  // 选填：不传 handler 时必须是空串，而不是 undefined ——
  // 记录页那一列、导出的单元格、撤销确认框都直接读它
  const hNone = await applyTransaction({
    time: '2026-09-20T11:00',
    name: 'M3螺丝',
    quantity: 1,
    type: 'in'
  })
  check(
    '不填经手人时存空串（不是 undefined）',
    hNone.ok && hNone.record.handler === '',
    hNone.ok ? JSON.stringify(hNone.record.handler) : hNone.error
  )

  // 落盘校验：重新从磁盘读一遍，而不是信内存
  const diskHandler = JSON.parse(await readFile(getDataFilePath(), 'utf8'))
  check(
    '经手人已落盘',
    diskHandler.records.some(
      (x: { handler?: string }) => x.handler === '经手人乙'
    ),
    JSON.stringify(diskHandler.records.slice(-3).map((x: { handler?: string }) => x.handler))
  )

  section('21. 仓库页搜索：命中置顶但其余不隐藏')
  const items = [
    { name: 'M3×8 螺丝' },
    { name: '贴片电阻 10kΩ' },
    { name: 'M4 螺丝' },
    { name: '铜线 1.5mm²' }
  ]
  const names = (list: Array<{ name: string }>): string => list.map((x) => x.name).join('|')

  check(
    '空搜索词时原样返回（连顺序都不动）',
    names(pinMatches(items, (i) => i.name, '')) === names(items) &&
      pinMatches(items, (i) => i.name, '') === items,
    names(pinMatches(items, (i) => i.name, ''))
  )
  const hit = pinMatches(items, (i) => i.name, '螺丝')
  check(
    '命中的两个排到最前，且**一个都没被隐藏**',
    hit.length === items.length && names(hit) === 'M3×8 螺丝|M4 螺丝|贴片电阻 10kΩ|铜线 1.5mm²',
    names(hit)
  )
  check(
    '命中的两个保持原有相对顺序（稳定，不是随机重排）',
    names(hit).indexOf('M3×8 螺丝') < names(hit).indexOf('M4 螺丝'),
    names(hit)
  )
  check(
    '未命中的也保持原有相对顺序',
    names(hit).indexOf('贴片电阻 10kΩ') < names(hit).indexOf('铜线 1.5mm²'),
    names(hit)
  )
  check('无命中时返回原顺序（不是空数组）', names(pinMatches(items, (i) => i.name, 'zzz')) === names(items))
  check('大小写不敏感', matchesItemQuery('PCB 打样板', 'pcb') === true)
  check('忽略搜索词首尾空白', matchesItemQuery('M3×8 螺丝', '  螺丝  ') === true)
  check('空搜索词不匹配任何项（否则全部会被标成命中）', matchesItemQuery('任何名称', '') === false)
  check('只按名称匹配，不匹配单位', matchesItemQuery('M3×8 螺丝', '个') === false)

  section('22. 经手人 / 领取人的文案')
  check('入库叫经手人', handlerLabel('in') === '经手人', handlerLabel('in'))
  check('出库叫领取人', handlerLabel('out') === '领取人', handlerLabel('out'))
  check(
    '列名同时含两种叫法（一条记录非入即出，共用一个字段）',
    HANDLER_COLUMN === '经手人/领取人',
    HANDLER_COLUMN
  )

  await rm(dir, { recursive: true, force: true })
  await rm(legacyDir, { recursive: true, force: true })
  console.log(`\n${'='.repeat(52)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('\n失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('数据层全部自检通过。')
}

main().catch((err) => {
  console.error('自检脚本异常终止：', err)
  process.exit(1)
})
