// 功能自测：用 mock ctx 驱动 dsh-ask-alert 的事件处理，验证触发与时序逻辑。
import { apply } from './index.js'

const spawns = []
const intervals = []
const handlers = new Map()

const ctx = {
  on(name, fn) {
    handlers.set(name, fn)
    return () => handlers.delete(name)
  },
  get(key) {
    if (key !== 'subprocess') return undefined
    return {
      spawn(spec) {
        spawns.push(spec)
        return { done: Promise.resolve() }
      },
    }
  },
  interval(cb, ms) {
    intervals.push({ cb, ms })
    return () => {}
  },
}

apply(ctx, { repeatSeconds: 20, maxAlerts: 3, showProject: true })

const argvOf = (spec) => spec.argv.join(' ')

// 1) 提问事件：应立即提醒，并在未回答时创建重复提醒
let answered
const answerPromise = new Promise((resolve) => {
  answered = resolve
})
const request = {
  questions: [
    { id: 'q1', header: '确认', question: '要现在打包吗？' },
    { id: 'q2', question: '要不要顺便加上图标？' },
  ],
  agent: {
    id: 's1',
    session: { header: { cwd: 'C:\\Users\\39301\\Documents\\deepseek-harness\\default-workspace' } },
  },
}

const askResult = handlers.get('user-questions/request')(request, () => answerPromise)
console.log('ask: spawn count =', spawns.length)
console.log('ask: argv =', argvOf(spawns[0]))
console.log('ask: interval =', intervals.length ? intervals[0].ms + 'ms' : 'none')

const firstIntervalMs = intervals.length ? intervals[0].ms : -1
const spawnsBeforeRepeat = spawns.length
intervals[0].cb()
console.log('ask: after one repeat spawn count =', spawns.length)
const repeatWorked = spawns.length === spawnsBeforeRepeat + 1

answered({ answers: [] })
await askResult
console.log('ask: resolved')

// 2) 任务完成事件（根会话 idle）
const before = spawns.length
handlers.get('agent/status')({
  status: 'idle',
  agent: { session: { header: { cwd: 'C:\\work\\demo' } } },
})
const doneSpawned = spawns.length - before
console.log('done: spawned =', doneSpawned)
console.log('done: argv =', argvOf(spawns[spawns.length - 1]))

// 3) 非根会话（子 agent）不提醒
const before2 = spawns.length
handlers.get('agent/status')({ status: 'idle', agent: { session: { header: { delegationDepth: 1 } } } })
const subagentSpawned = spawns.length - before2
console.log('subagent idle: spawned =', subagentSpawned, '(expect 0)')

// 4) 审批事件
const before3 = spawns.length
const approval = handlers.get('approval/request')(
  { agent: { session: { header: { cwd: 'C:\\work\\demo' } } }, toolName: 'pwsh', reason: '需要写入 D 盘' },
  () => Promise.resolve('allowed-once'),
)
await approval
const approvalSpawned = spawns.length - before3
console.log('approve: spawned =', approvalSpawned)

const checks = {
  spawnOnAsk: spawns.length > 0,
  bypassFlag: argvOf(spawns[0]).includes('-ExecutionPolicy Bypass'),
  questionText: argvOf(spawns[0]).includes('确认：要现在打包吗？'),
  multiCount: argvOf(spawns[0]).includes('共 2 个问题'),
  projectLabel: argvOf(spawns[0]).includes('default-workspace'),
  repeatInterval: firstIntervalMs === 20000,
  repeatWorked,
  doneNotified: doneSpawned === 1,
  subagentSilent: subagentSpawned === 0,
  approvalNotified: approvalSpawned === 1,
}
console.log(JSON.stringify(checks, null, 2))
console.log(Object.values(checks).every(Boolean) ? 'SELFTEST_OK' : 'SELFTEST_FAILED')

