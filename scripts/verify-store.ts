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
import { applyTransaction, deleteRecord } from '../src/main/store/transactions'

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
    type: 'in'
  })
  check('入库成功', r.ok === true, r.ok ? '' : r.error)
  if (r.ok) {
    check('库存 = 100', r.item.quantity === 100, `实际 ${r.item.quantity}`)
    check('单位 = 个', r.item.unit === '个', `实际 ${r.item.unit}`)
    check('记录方向 = in', r.record.type === 'in')
    check('记录单位存的是快照', r.record.unit === '个')
    check('操作人快照 = 张三', r.record.operator === '张三')
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

  section('16. 旧数据无 operator 字段时自动补空串')
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
