// Pure helpers for driving `pi --mode json` as a Claude Code subagent:
// model references, argv, the event stream, and the Agent tool's record.
// Nothing here touches `$`, so it is tested directly.

import type { PiModel, PiModelRow, PiProfile, PiRun, PiSettings, PiStep } from '../types'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const TIER_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type TierAlias = (typeof TIER_ALIASES)[number]

export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']
export const BUILTIN_AGENTS = ['agent', 'explore'] as const

export const EMPTY_SETTINGS: PiSettings = { tiers: {}, profiles: [] }

/**
 * Parses `provider/model[:thinking]`. The provider is the first path segment,
 * so OpenRouter ids such as `openrouter/anthropic/claude-x` keep their slash.
 * A bare `model` (no provider) is allowed; pi then resolves it by pattern.
 */
export function parseModelRef(ref: string): PiModel | undefined {
  const text = ref.trim()
  if (text === '') return undefined
  let body = text
  let thinking: string | undefined
  const colon = text.lastIndexOf(':')
  if (colon > 0) {
    const level = text.slice(colon + 1)
    if ((THINKING_LEVELS as readonly string[]).includes(level)) {
      thinking = level
      body = text.slice(0, colon)
    }
  }
  const slash = body.indexOf('/')
  const provider = slash > 0 ? body.slice(0, slash) : ''
  const model = slash > 0 ? body.slice(slash + 1) : body
  if (model === '') return undefined
  return thinking === undefined ? { provider, model } : { provider, model, thinking }
}

export function formatModel(m: PiModel | undefined, withThinking = true): string {
  if (m === undefined) return 'pi default'
  const id = m.provider === '' ? m.model : `${m.provider}/${m.model}`
  return withThinking && m.thinking !== undefined ? `${id}:${m.thinking}` : id
}

/** Parses the table `pi --list-models` prints. */
export function parseModelList(stdout: string): PiModelRow[] {
  const rows: PiModelRow[] = []
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || cols[0] === 'provider') continue
    const [provider, model, context, , thinking] = cols
    if (provider === undefined || model === undefined) continue
    rows.push({ provider, model, context: context ?? '', thinking: thinking === 'yes' })
  }
  return rows
}

export function filterModels(rows: readonly PiModelRow[], filter: string): PiModelRow[] {
  const words = filter.toLowerCase().split(/\s+/).filter(w => w !== '')
  if (words.length === 0) return [...rows]
  return rows.filter(r => {
    const id = `${r.provider}/${r.model}`.toLowerCase()
    return words.every(w => id.includes(w))
  })
}

/** What one pi subagent run is asked to do and on what. */
export type RunPlan = {
  agentType: string
  model?: PiModel
  readOnly: boolean
}

/**
 * Decides which model and tools a pi agent type runs with. Precedence for the
 * model: a profile's own model, then the Agent call's `model` alias mapped
 * through the tiers, then the default; the call's `effort` overrides thinking.
 */
export function planRun(
  settings: PiSettings,
  agentName: string,
  alias?: string,
  effort?: string,
): RunPlan | undefined {
  const profile = settings.profiles.find(p => p.name === agentName)
  const isBuiltin = (BUILTIN_AGENTS as readonly string[]).includes(agentName)
  if (profile === undefined && !isBuiltin) return undefined
  const tier = alias !== undefined ? settings.tiers[alias as TierAlias] : undefined
  let model = profile?.model ?? tier ?? settings.defaultModel
  if (effort !== undefined && model !== undefined) model = { ...model, thinking: effort }
  if (effort !== undefined && model === undefined) model = { provider: '', model: '', thinking: effort }
  const readOnly = profile?.readOnly ?? agentName === 'explore'
  return { agentType: `pi:${agentName}`, model, readOnly }
}

export const SUBAGENT_BRIEF = [
  'You are running as a subagent dispatched by Claude Code (the orchestrating agent).',
  'Work autonomously: there is no human to answer questions mid-task, so make reasonable assumptions and state them.',
  'Your final message is the only thing returned to the orchestrator. End with a concise, self-contained report:',
  'what you did, what you found, files you changed (with paths), and anything left undone.',
].join(' ')

export const READ_ONLY_BRIEF =
  'You are in read-only mode: investigate and report; do not attempt to modify files.'

export function buildArgv(opts: {
  piPath: string
  plan: RunPlan
  prompt: string
  isolate: boolean
}): string[] {
  const { piPath, plan, prompt, isolate } = opts
  const argv = [piPath, '--print', '--mode', 'json', '--no-session']
  const m = plan.model
  if (m !== undefined && m.model !== '') {
    argv.push('--model', m.provider === '' ? m.model : `${m.provider}/${m.model}`)
  }
  if (m?.thinking !== undefined) argv.push('--thinking', m.thinking)
  if (plan.readOnly) argv.push('--tools', READ_ONLY_TOOLS.join(','))
  if (isolate) argv.push('--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes')
  argv.push('--append-system-prompt', plan.readOnly ? `${SUBAGENT_BRIEF}\n\n${READ_ONLY_BRIEF}` : SUBAGENT_BRIEF)
  argv.push('--', prompt)
  return argv
}

// ---------------------------------------------------------------------------
// The event stream

type Json = Record<string, unknown>

/** Everything one run accumulates from pi's JSON lines. */
export type RunTally = {
  steps: PiStep[]
  pending: Record<string, number>
  toolCount: number
  toolsUsed: string[]
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  models: string[]
  finalText: string
  tail: string
  error?: string
  isSettled: boolean
  stats: { read: number; search: number; bash: number; edit: number; other: number }
}

export function newTally(): RunTally {
  return {
    steps: [],
    pending: {},
    toolCount: 0,
    toolsUsed: [],
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    models: [],
    finalText: '',
    tail: '',
    isSettled: false,
    stats: { read: 0, search: 0, bash: 0, edit: 0, other: 0 },
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A short label for a tool call, the way Claude Code's own rows read. */
export function summarizeCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Json
  const pick =
    str(a.command) || str(a.path) || str(a.file_path) || str(a.pattern) || str(a.query) || str(a.url)
  return oneLine(pick === '' ? JSON.stringify(a) : pick, 80)
}

function countStat(tally: RunTally, tool: string): void {
  if (tool === 'read') tally.stats.read++
  else if (tool === 'grep' || tool === 'find' || tool === 'ls') tally.stats.search++
  else if (tool === 'bash') tally.stats.bash++
  else if (tool === 'edit' || tool === 'write') tally.stats.edit++
  else tally.stats.other++
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is Json => typeof b === 'object' && b !== null && (b as Json).type === 'text')
    .map(b => str(b.text))
    .join('')
}

/** Folds one parsed JSON event into the tally (mutates and returns it). */
export function applyEvent(tally: RunTally, event: Json): RunTally {
  switch (event.type) {
    case 'tool_execution_start': {
      const tool = str(event.toolName)
      tally.pending[str(event.toolCallId)] = tally.steps.length
      tally.steps.push({ tool, summary: summarizeCall(tool, event.args), isDone: false, isError: false })
      tally.toolCount++
      if (!tally.toolsUsed.includes(tool)) tally.toolsUsed.push(tool)
      countStat(tally, tool)
      break
    }
    case 'tool_execution_end': {
      const at = tally.pending[str(event.toolCallId)]
      const step = at === undefined ? undefined : tally.steps[at]
      if (step !== undefined) {
        step.isDone = true
        step.isError = event.isError === true
      }
      break
    }
    case 'message_update': {
      const inner = event.assistantMessageEvent as Json | undefined
      if (inner?.type === 'text_delta') tally.tail = (tally.tail + str(inner.delta)).slice(-400)
      break
    }
    case 'message_end': {
      const msg = event.message as Json | undefined
      if (msg?.role !== 'assistant') break
      const usage = (msg.usage ?? {}) as Json
      tally.input += Number(usage.input ?? 0)
      tally.output += Number(usage.output ?? 0)
      tally.cacheRead += Number(usage.cacheRead ?? 0)
      tally.cacheWrite += Number(usage.cacheWrite ?? 0)
      tally.cost += Number(((usage.cost ?? {}) as Json).total ?? 0)
      const model = `${str(msg.provider)}/${str(msg.model)}`
      if (model !== '/' && !tally.models.includes(model)) tally.models.push(model)
      const text = textOf(msg.content)
      if (text.trim() !== '') tally.finalText = text
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
        tally.error = str(msg.errorMessage) || `pi stopped: ${str(msg.stopReason)}`
      } else if (text.trim() !== '') {
        tally.error = undefined
      }
      break
    }
    case 'agent_settled':
      tally.isSettled = true
      if (event.aborted === true && tally.error === undefined) tally.error = 'pi run was aborted'
      break
    default:
      break
  }
  return tally
}

/** Splits streamed stdout into complete lines, keeping the unfinished rest. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(l => l.trim() !== ''), rest }
}

export function parseLine(line: string): Json | undefined {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

/** The live row's view of a run, small enough to redraw often. */
export function viewOf(base: PiRun, tally: RunTally): PiRun {
  return {
    ...base,
    steps: tally.steps.slice(-6),
    toolCount: tally.toolCount,
    tokens: tally.input + tally.output + tally.cacheRead + tally.cacheWrite,
    cost: tally.cost,
    tail: oneLine(tally.tail, 160),
    model: tally.models[tally.models.length - 1] ?? base.model,
  }
}

/** The Agent tool's `completed` record, so Claude Code reads a pi run as its own. */
export function agentRecord(opts: {
  agentId: string
  agentType: string
  prompt: string
  tally: RunTally
  durationMs: number
}) {
  const { agentId, agentType, prompt, tally, durationMs } = opts
  const model = tally.models[tally.models.length - 1]
  const text =
    tally.finalText.trim() === '' ? '(pi finished without a final message)' : tally.finalText
  return {
    status: 'completed' as const,
    // pi runs are one-shot (--no-session): there is no agent to SendMessage.
    canContinueAgent: false,
    agentId,
    agentType,
    prompt,
    content: [{ type: 'text' as const, text }],
    ...(model !== undefined ? { resolvedModel: `pi:${model}`, modelsUsed: tally.models.map(m => `pi:${m}`) } : {}),
    totalToolUseCount: tally.toolCount,
    totalDurationMs: durationMs,
    totalTokens: tally.input + tally.output + tally.cacheRead + tally.cacheWrite,
    usage: {
      input_tokens: tally.input,
      output_tokens: tally.output,
      cache_creation_input_tokens: tally.cacheWrite,
      cache_read_input_tokens: tally.cacheRead,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    toolsUsed: tally.toolsUsed,
    toolStats: {
      readCount: tally.stats.read,
      searchCount: tally.stats.search,
      bashCount: tally.stats.bash,
      editFileCount: tally.stats.edit,
      linesAdded: 0,
      linesRemoved: 0,
      otherToolCount: tally.stats.other,
    },
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function formatCost(c: number): string {
  return c <= 0 ? '' : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`
}

/** Agent type name check: letters, digits, `_`, `-`; up to 64. */
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) && !(BUILTIN_AGENTS as readonly string[]).includes(name)
}

export function profileDescription(p: PiProfile): string {
  const base =
    p.description ??
    (p.readOnly
      ? 'Read-only pi subagent for searching and investigating code.'
      : 'pi subagent that can read, run commands and edit files.')
  return `${base} Runs on the pi coding agent with ${formatModel(p.model)}.`
}
