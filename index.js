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
 * 只消费生命周期事件并通过 subprocess 拉起 notify.ps1，不注册任何 service/tool/settings。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
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
          cfg.sound === false ? '0' : '1',
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

    const intervalSec = Number(cfg.repeatSeconds) || 0
    const maxAlerts = Number(cfg.maxAlerts) || 0
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
    if (cfg.showProject === false) return body
    const label = projectLabel(session)
    return label ? `${label} · ${body}` : body
  }

  // 1) 助手向你提问：提醒会一直重复，直到你回答（next() 结算）
  ctx.on('user-questions/request', async (request, next) => {
    const detail = questionSummary(request)
    const title = cfg.askTitle
    const body = withProject(detail ?? cfg.askBody, request?.agent?.session)
    const stop = startReminder('ask', title, body)
    try {
      return await next()
    } finally {
      stop()
    }
  })

  // 2) 审批请求：同样重复提醒，直到批准/拒绝
  ctx.on('approval/request', (request, next) => {
    if (cfg.onApproval === false) return next()
    const title = cfg.approveTitle
    const reason =
      typeof request?.reason === 'string' && request.reason.length > 0
        ? clip(request.reason, 120)
        : cfg.approveBody
    const body = withProject(reason, request?.agent?.session)
    const done = next()
    const stop = startReminder('approve', title, body)
    Promise.resolve(done).then(stop, stop)
    return done
  })

  // 3) 一轮任务结束：单次提醒，方便离开屏幕后知道可以回来看结果
  ctx.on('agent/status', (payload) => {
    if (cfg.onDone === false) return
    if (payload?.status !== 'idle') return
    if (!isRoot(payload?.agent)) return
    const body = withProject(cfg.doneBody, payload?.agent?.session)
    fire('done', cfg.doneTitle, body)
  })
}
