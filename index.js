/**
 * dsh-ask-alert — 桌面提醒插件（Host 半身）
 *
 * 触发时机：
 *   - 助手通过 ask_user_question 向你提问（user-questions/request）
 *   - 有操作等待你批准/拒绝（approval/request）
 *   - 一轮任务结束、助手转为空闲（agent/status => idle，仅根会话）
 *
 * 提醒方式：Windows 原生 toast + 任务栏闪烁（DSH 在后台时一直闪到你切换回来）
 *          + 系统提示音；提问/审批未回答时按 repeatSeconds 重复提醒，最多 maxAlerts 次。
 *
 * 只消费生命周期事件并通过 subprocess 拉起 notify.ps1，不注册任何 service/tool；
 * 导出 Config schema，让插件设置页据此生成表单（不必手改 cordis.patch.yml）。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, 'notify.ps1')

const DEFAULTS = {
  askTitle: 'DSH · 有个问题等你回答',
  askBody: '助手在等你回复，请切回 DeepSeek Harness。',
  approveTitle: 'DSH · 需要你确认',
  approveBody: '有一个操作正在等你批准或拒绝。',
  doneTitle: 'DSH · 任务完成',
  doneBody: '这一轮任务已结束，可以回来查看结果了。',
  repeatSeconds: 20, // 未回答时重复提醒间隔；0 = 只提醒一次
  maxAlerts: 5, // 最多提醒次数（含第一次）
  onApproval: true,
  onDone: true,
  showProject: true,
  sound: true,
}

/**
 * 配置项声明。字段都是 `.volatile()` 的：这类字段归用户所有，插件管理器里
 * 由本包的浏览器半边（`lib/client.js`）画成表单，改动写进当前 profile 的
 * Cordis patch 文件；而普通字段是作者定死的组合参数，用户改不动。
 *
 * 用户没填时，这些字段在运行时可能是空对象占位而不是 DEFAULTS 的值，
 * 所以 `apply()` 里统一按类型挑值（见 `pick()`），不认识的值一律退回 DEFAULTS。
 */
export const Config = z.object({
  askTitle: z.string().default(DEFAULTS.askTitle).description('助手提问时提醒卡片的标题').volatile(),
  askBody: z.string().default(DEFAULTS.askBody).description('提问没有附带文字时的正文').volatile(),
  approveTitle: z.string().default(DEFAULTS.approveTitle).description('审批请求时提醒卡片的标题').volatile(),
  approveBody: z.string().default(DEFAULTS.approveBody).description('审批请求没有给出理由时的正文').volatile(),
  doneTitle: z.string().default(DEFAULTS.doneTitle).description('一轮任务结束时提醒卡片的标题').volatile(),
  doneBody: z.string().default(DEFAULTS.doneBody).description('一轮任务结束时提醒卡片的正文').volatile(),
  repeatSeconds: z
    .number()
    .min(0)
    .default(DEFAULTS.repeatSeconds)
    .description('提问/审批未处理时的重复提醒间隔（秒），0 = 只提醒一次')
    .volatile(),
  maxAlerts: z
    .number()
    .min(1)
    .default(DEFAULTS.maxAlerts)
    .description('最多提醒次数（含第一次）')
    .volatile(),
  onApproval: z.boolean().default(DEFAULTS.onApproval).description('审批请求时是否提醒').volatile(),
  onDone: z.boolean().default(DEFAULTS.onDone).description('一轮任务结束时是否提醒').volatile(),
  showProject: z.boolean().default(DEFAULTS.showProject).description('在提醒正文前加上项目目录名').volatile(),
  sound: z.boolean().default(DEFAULTS.sound).description('提醒时是否播放提示音').volatile(),
})

function pickPowerShell() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

function projectLabel(session) {
  try {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    const name = parts[parts.length - 1]
    return name && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

function questionSummary(request) {
  const items = Array.isArray(request?.questions) ? request.questions : []
  if (items.length === 0) return undefined
  const first = items[0]
  const head = typeof first?.header === 'string' && first.header.length > 0 ? first.header + '：' : ''
  const text = clip(head + (first?.question ?? ''), 120)
  return items.length > 1 ? `${text}（共 ${items.length} 个问题）` : text
}

export const name = 'dsh-ask-alert'
export const inject = ['subprocess']

/**
 * volatile 字段在运行时不是普通值，而是一个只读引用（形如 `{ get() }`）：
 * Loader 把设置页保存的新值写进这个引用的内部快照、不重启插件 fiber，
 * 所以必须每次调用 `.get()` 现读；当成字符串/布尔直接用会全部退回默认值。
 */
function read(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function' ? value.get() : value
}

/**
 * 按 DEFAULTS 的类型挑一个用户值：volatile 字段没人填时可能是空占位，
 * 类型不对就当没填，避免把一个 `{}` 当成 true 或把 "abc" 当成间隔。
 */
function pick(value, fallback) {
  value = read(value)
  switch (typeof fallback) {
    case 'string':
      return typeof value === 'string' && value.length > 0 ? value : fallback
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : fallback
    default:
      return fallback
  }
}

export function apply(ctx, config) {
  /**
   * 每次现读，不拷快照：volatile 字段在设置页保存后，Loader 把新值直接写进
   * 传给 `apply` 的同一个 config 对象（并发 `loader/volatile-update`），
   * 不会重启插件 fiber，拷成快照就永远停在启动那一刻。
   */
  const opt = (key) => pick(config?.[key], DEFAULTS[key])
  const powershell = pickPowerShell()
  const lastByKind = new Map()

  const isRoot = (agent) => {
    try {
      const depth = agent?.session?.header?.delegationDepth
      return depth === undefined || depth === 0
    } catch {
      return true
    }
  }

  const fire = (kind, title, body, force = false) => {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return
    const now = Date.now()
    if (!force && now - (lastByKind.get(kind) ?? 0) < 1200) return
    lastByKind.set(kind, now)
    try {
      const handle = subprocess.spawn({
        argv: [
          powershell,
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          SCRIPT_PATH,
          '-Kind',
          kind,
          '-Title',
          title,
          '-Body',
          body,
          '-Sound',
          opt('sound') === false ? '0' : '1',
        ],
        cwd: process.env.TEMP ?? 'C:\\Windows\\Temp',
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 4000,
      })
      handle?.done?.catch?.(() => {})
    } catch (error) {
      console.error('[dsh-ask-alert] 无法启动提示进程:', error)
    }
  }

  /**
   * 立即提醒一次，并在未处理时按间隔重复提醒。
   * 返回停止函数，调用方在拿到用户回答后立刻停止。
   */
  const startReminder = (kind, title, body) => {
    let count = 1
    let stopped = false
    fire(kind, title, body)

    const intervalSec = opt('repeatSeconds')
    const maxAlerts = opt('maxAlerts')
    if (intervalSec <= 0 || maxAlerts <= 1) return () => {}

    const stopRepeat = ctx.interval(() => {
      if (stopped) return
      count += 1
      if (count > maxAlerts) {
        stopped = true
        stopRepeat()
        return
      }
      fire(kind, title, body, true)
    }, intervalSec * 1000)

    return () => {
      if (stopped) return
      stopped = true
      stopRepeat()
    }
  }

  const withProject = (body, session) => {
    if (opt('showProject') === false) return body
    const label = projectLabel(session)
    return label ? `${label} · ${body}` : body
  }

  // 1) 助手向你提问：提醒会一直重复，直到你回答（next() 结算）
  ctx.on('user-questions/request', async (request, next) => {
    const detail = questionSummary(request)
    const title = opt('askTitle')
    const body = withProject(detail ?? opt('askBody'), request?.agent?.session)
    const stop = startReminder('ask', title, body)
    try {
      return await next()
    } finally {
      stop()
    }
  })

  // 2) 审批请求：同样重复提醒，直到批准/拒绝
  ctx.on('approval/request', (request, next) => {
    if (opt('onApproval') === false) return next()
    const title = opt('approveTitle')
    const reason =
      typeof request?.reason === 'string' && request.reason.length > 0
        ? clip(request.reason, 120)
        : opt('approveBody')
    const body = withProject(reason, request?.agent?.session)
    const done = next()
    const stop = startReminder('approve', title, body)
    Promise.resolve(done).then(stop, stop)
    return done
  })

  // 3) 一轮任务结束：单次提醒，方便离开屏幕后知道可以回来看结果
  ctx.on('agent/status', (payload) => {
    if (opt('onDone') === false) return
    if (payload?.status !== 'idle') return
    if (!isRoot(payload?.agent)) return
    const body = withProject(opt('doneBody'), payload?.agent?.session)
    fire('done', opt('doneTitle'), body)
  })
}
