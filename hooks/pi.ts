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

/**
 * Where a run keeps its pi session. A fresh attempt names its own session
 * `id`; a retry `fork`s the session an earlier attempt left, which keeps the
 * work done so far under a new session id. Without one the run is ephemeral.
 */
export type SessionArgs = { dir: string; id?: string; fork?: string }

export function buildArgv(opts: {
  piPath: string
  plan: RunPlan
  prompt: string
  isolate: boolean
  session?: SessionArgs
}): string[] {
  const { piPath, plan, prompt, isolate, session } = opts
  const argv = [piPath, '--print', '--mode', 'json']
  if (session === undefined) argv.push('--no-session')
  else {
    argv.push('--session-dir', session.dir)
    if (session.fork !== undefined) argv.push('--fork', session.fork)
    else if (session.id !== undefined) argv.push('--session-id', session.id)
  }
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
  /** Tool calls started and not yet ended in this attempt: pi is running a tool, not waiting on the model. */
  openTools: string[]
  /** The pi session this attempt writes, from pi's `session` header. */
  sessionId?: string
  /** Whether this attempt's session holds any message yet (so it can be forked). */
  sawMessage: boolean
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
    openTools: [],
    sawMessage: false,
  }
}

/**
 * Readies a tally for another attempt of the same run. Counts, tokens, cost
 * and steps carry over; the answer, the error and the session start again.
 * Steps the killed attempt left running are marked failed.
 */
export function beginAttempt(tally: RunTally): RunTally {
  for (const id of tally.openTools) {
    const step = tally.steps[tally.pending[id] ?? -1]
    if (step !== undefined && !step.isDone) {
      step.isDone = true
      step.isError = true
    }
  }
  tally.openTools = []
  tally.finalText = ''
  tally.tail = ''
  tally.error = undefined
  tally.isSettled = false
  tally.sessionId = undefined
  tally.sawMessage = false
  return tally
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
    case 'session':
      if (str(event.id) !== '') tally.sessionId = str(event.id)
      break
    case 'tool_execution_start': {
      const tool = str(event.toolName)
      tally.pending[str(event.toolCallId)] = tally.steps.length
      tally.openTools.push(str(event.toolCallId))
      tally.steps.push({ tool, summary: summarizeCall(tool, event.args), isDone: false, isError: false })
      tally.toolCount++
      if (!tally.toolsUsed.includes(tool)) tally.toolsUsed.push(tool)
      countStat(tally, tool)
      break
    }
    case 'tool_execution_end': {
      tally.openTools = tally.openTools.filter(id => id !== str(event.toolCallId))
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
      if (msg !== undefined) tally.sawMessage = true
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
  /** A line from the bridge appended to the report, e.g. that the run recovered from a stall. */
  note?: string
}) {
  const { agentId, agentType, prompt, tally, durationMs, note } = opts
  const model = tally.models[tally.models.length - 1]
  const answer =
    tally.finalText.trim() === '' ? '(pi finished without a final message)' : tally.finalText
  const text = note === undefined ? answer : `${answer}\n\n${note}`
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

// ---------------------------------------------------------------------------
// Plugin options, background choice, watchdogs and failure messages

export const BACKGROUND_MODES = ['auto', 'always', 'never'] as const
export type BackgroundMode = (typeof BACKGROUND_MODES)[number]

export const DEFAULT_IDLE_TIMEOUT_SEC = 180
export const DEFAULT_MAX_RUN_MINUTES = 30
export const DEFAULT_STALL_TIMEOUT_SEC = 90
export const DEFAULT_STALL_RETRIES = 2

/**
 * How long a run may stay silent and how long it may run at all.
 * - `stallMs`: no pi event while pi waits on the model (a stalled provider).
 * - `idleMs`: no pi event while one of pi's tools runs (a hung command).
 * - `wallMs`: the whole run, retries included.
 */
export type RunLimits = { idleMs: number; wallMs: number; stallMs: number }

export type PluginSettings = {
  piPath: string
  isolate: boolean
  background: BackgroundMode
  limits: RunLimits
  /** How many times a stalled run is resumed in a fresh pi session before it fails. */
  retries: number
}

function positive(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback
}

function count(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(10, Math.floor(n)) : fallback
}

/** Reads the plugin's `userConfig` values, falling back to defaults on anything odd. */
export function readOptions(options: Readonly<Record<string, unknown>>): PluginSettings {
  const piPath = typeof options.piPath === 'string' && options.piPath.trim() !== '' ? options.piPath : 'pi'
  const mode = typeof options.background === 'string' ? options.background.trim().toLowerCase() : ''
  return {
    piPath,
    isolate: options.isolate !== false,
    background: (BACKGROUND_MODES as readonly string[]).includes(mode) ? (mode as BackgroundMode) : 'auto',
    limits: {
      idleMs: positive(options.idleTimeoutSec, DEFAULT_IDLE_TIMEOUT_SEC) * 1000,
      wallMs: positive(options.maxRunMinutes, DEFAULT_MAX_RUN_MINUTES) * 60_000,
      stallMs: positive(options.stallTimeoutSec, DEFAULT_STALL_TIMEOUT_SEC) * 1000,
    },
    retries: count(options.stallRetries, DEFAULT_STALL_RETRIES),
  }
}

/**
 * Whether the host's Agent tool lets the model ask for a background run, read
 * off the tool's description (the only part of its schema a plugin can see).
 * Undefined when the description is unknown.
 */
export function hostExposesBackground(agentDescription: string | undefined): boolean | undefined {
  if (agentDescription === undefined) return undefined
  return /run_in_background/.test(agentDescription)
}

/**
 * Combines what the host told us about its Agent tool. `described` comes from
 * the full description (`tool.describe`); `summary` is `$.tool.list()`'s,
 * which the engine cuts to its first 300 characters, so a summary can prove
 * the parameter is there but never that it is missing.
 */
export function resolveHostExposes(described: boolean | undefined, summary: string | undefined): boolean | undefined {
  if (described !== undefined) return described
  return hostExposesBackground(summary) === true ? true : undefined
}

/**
 * Decides whether one Agent call runs in the background.
 *
 * - `always` / `never` force it.
 * - `auto` honours an explicit `run_in_background` on the call. When the call
 *   carries none and the host's Agent tool has no such parameter (so the model
 *   could not have asked), the run goes to the background: a long pi run in
 *   the foreground blocks the whole turn. When the host does offer the
 *   parameter, or we can't tell, its absence means foreground.
 */
export function decideBackground(
  mode: BackgroundMode,
  flag: unknown,
  hostExposes: boolean | undefined,
): { background: boolean; reason: string } {
  if (mode === 'always') return { background: true, reason: 'background: "always"' }
  if (mode === 'never') return { background: false, reason: 'background: "never"' }
  if (flag === true) return { background: true, reason: 'run_in_background: true' }
  if (flag === false) return { background: false, reason: 'run_in_background: false' }
  if (hostExposes === false) {
    return { background: true, reason: 'the Agent tool here has no run_in_background parameter' }
  }
  return { background: false, reason: 'run_in_background not set' }
}

/** `stall`: silent while waiting on the model; `idle`: silent while a tool runs; `wall`: too long in all. */
export type WatchdogKind = 'idle' | 'wall' | 'stall'

/**
 * Which watchdog, if any, has expired for a run. Silence means something
 * different by phase: while a pi tool runs (a long build, a slow test) it is
 * normal, so only the idle limit applies; while pi waits on the model it means
 * the provider has stalled, and the (shorter) stall limit applies.
 */
export function watchdogCheck(opts: {
  now: number
  startedAt: number
  lastEventAt: number
  limits: RunLimits
  /** Whether a pi tool is running right now. */
  isToolRunning?: boolean
  /** The stall limit for this attempt; defaults to `limits.stallMs`. */
  stallMs?: number
}): WatchdogKind | undefined {
  const { now, startedAt, lastEventAt, limits } = opts
  if (now - startedAt >= limits.wallMs) return 'wall'
  const silent = now - lastEventAt
  if (opts.isToolRunning === true) return silent >= limits.idleMs ? 'idle' : undefined
  return silent >= (opts.stallMs ?? limits.stallMs) ? 'stall' : undefined
}

/**
 * The stall limit for an attempt (0 is the first): it doubles on each retry,
 * so a model that legitimately thinks in silence for long still gets through
 * while a provider that stalled is dropped quickly the first time.
 */
export function stallLimitFor(limits: RunLimits, attempt: number): number {
  return limits.stallMs * 2 ** Math.max(0, attempt)
}

// Errors a fresh request may well not hit again: timeouts, dropped streams,
// overloaded or failing upstreams (OpenRouter relays these from its providers).
const TRANSIENT =
  /timed? ?out|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|stream (?:ended|closed|error)|premature close|overloaded|bad gateway|gateway time|upstream (?:error|connect)|provider returned error|\b(?:408|425|429|500|502|503|504|520|522|524|529)\b/i

/** Whether a provider error from pi looks transient (worth a fresh attempt). */
export function isTransientError(message: string): boolean {
  return TRANSIENT.test(message)
}

/** Whether a failed attempt is worth resuming in a fresh pi session. */
export function isRetryable(cause: FailureCause): boolean {
  if (cause.kind === 'watchdog') return cause.watchdog === 'stall'
  if (cause.kind === 'provider') return isTransientError(cause.message)
  return false
}

/**
 * How many retries a run gets: `retries`, raised so every fallback model gets
 * one retry of its own; 0 turns retrying off.
 */
export function retryBudget(retries: number, fallbacks: readonly PiModel[]): number {
  return retries === 0 ? 0 : Math.max(retries, 1 + fallbacks.length)
}

/**
 * The model retry `n` (1 is the first retry) runs on. The first retry keeps
 * the model: a fresh session gets a fresh route, and on OpenRouter usually
 * another upstream provider. Later retries walk the fallback list, keeping
 * the run's thinking level when the fallback names none.
 */
export function retryModel(
  n: number,
  model: PiModel | undefined,
  fallbacks: readonly PiModel[],
): PiModel | undefined {
  const fallback = n >= 2 ? fallbacks[n - 2] : undefined
  if (fallback === undefined) return model
  return fallback.thinking === undefined && model?.thinking !== undefined
    ? { ...fallback, thinking: model.thinking }
    : fallback
}

/** What a resumed attempt is told, on top of the session it continues. */
export const CONTINUE_PROMPT = [
  'Your previous attempt at this task was cut off because the model provider stalled or failed (this is not something you did).',
  'Continue the task from where it stopped, using what is already in this conversation. Do not redo work that is already done;',
  'if a tool call has no result, check its effect before running it again.',
  'When you are done, end with the final report as instructed.',
].join(' ')

/** One line on why an attempt ended, for the run's history. */
export function attemptSummary(opts: {
  n: number
  model: string
  cause: FailureCause
  stallMs: number
  elapsedMs: number
}): string {
  const { n, model, cause, stallMs, elapsedMs } = opts
  const why =
    cause.kind === 'watchdog' && cause.watchdog === 'stall'
      ? `stalled (no events for ${formatDuration(stallMs)} while waiting on the model)`
      : cause.kind === 'provider'
        ? `provider error: ${oneLine(cause.message, 160)}`
        : cause.kind
  return `attempt ${n} on ${model}: ${why}, after ${formatDuration(elapsedMs)}`
}

/** The line a recovered run's report ends with. */
export function recoveryNote(history: readonly string[], model: string): string | undefined {
  if (history.length === 0) return undefined
  return `[pi bridge: ${history.length === 1 ? 'one attempt' : `${history.length} attempts`} failed (${history.join('; ')}); the run was resumed in a fresh pi session and finished on ${model}.]`
}

const STDERR_NOISE = /^Warning: Extension package/

/** The last `n` meaningful lines pi wrote to stderr. */
export function stderrTail(stderr: string, n = 5): string[] {
  return stderr
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '' && !STDERR_NOISE.test(l))
    .slice(-n)
}

/** The run's last tool step, as one line. */
export function lastStep(tally: RunTally): string | undefined {
  const s = tally.steps[tally.steps.length - 1]
  if (s === undefined) return undefined
  const state = s.isError ? 'failed' : s.isDone ? 'done' : 'still running'
  return `${s.tool} ${s.summary} (${state})`
}

/** Why a run ended without an answer. */
export type FailureCause =
  | { kind: 'user' }
  | { kind: 'watchdog'; watchdog: WatchdogKind }
  | { kind: 'provider'; message: string }
  | { kind: 'exit'; code: number | null; signal: string | null }
  | { kind: 'spawn'; message: string }

/**
 * Classifies how a run ended: a watchdog kill and the person's Esc come
 * first (both abort pi), then pi's own error, then a bad exit.
 */
export function classifyEnd(opts: {
  watchdog?: WatchdogKind
  aborted: boolean
  spawnError?: string
  tally: RunTally
  exit?: { code: number | null; signal: string | null }
}): FailureCause | undefined {
  const { watchdog, aborted, spawnError, tally, exit } = opts
  if (watchdog !== undefined) return { kind: 'watchdog', watchdog }
  if (aborted) return { kind: 'user' }
  if (spawnError !== undefined) return { kind: 'spawn', message: spawnError }
  if (tally.error !== undefined) return { kind: 'provider', message: tally.error }
  if (exit !== undefined && exit.code !== 0 && tally.finalText.trim() === '') {
    return { kind: 'exit', code: exit.code, signal: exit.signal }
  }
  return undefined
}

/** The message the model (or a task notification) reads for a failed run. */
export function failureMessage(opts: {
  cause: FailureCause
  agentType: string
  model: string
  elapsedMs: number
  limits: RunLimits
  tally: RunTally
  stderr: string
  piPath?: string
  /** The stall limit the last attempt ran under. */
  stallMs?: number
  /** Earlier attempts that failed and were retried, one line each. */
  history?: readonly string[]
  /** How to pick the run up by hand, when its pi session was kept. */
  resumeHint?: string
}): string {
  const { cause, agentType, model, elapsedMs, limits, tally } = opts
  const tries = (opts.history?.length ?? 0) + 1
  const after = tries > 1 ? ` on attempt ${tries} of ${tries}` : ''
  const ran = formatDuration(elapsedMs)
  const who = `${agentType} on ${model}`
  let head: string
  let hint: string
  switch (cause.kind) {
    case 'user':
      head = `The pi subagent ${who} was interrupted by the user (Esc) after ${ran}.`
      hint = 'Ask the user before retrying; for long work use run_in_background, or pi through Bash in the background.'
      break
    case 'watchdog':
      if (cause.watchdog === 'stall') {
        head = `The pi watchdog stopped ${who}${after}: the model sent nothing for ${formatDuration(opts.stallMs ?? limits.stallMs)} while pi waited on it (stall limit), after ${ran} in total.`
        hint =
          'The provider looks stalled. Retry later, add fallback models with /pi fallback add <provider/model>, or pick another model with /pi. ' +
          'On OpenRouter, steer routing to faster upstream providers (openRouterRouting in pi’s models.json). ' +
          'If this model just thinks silently for long, raise the plugin option stallTimeoutSec.'
      } else if (cause.watchdog === 'idle') {
        head = `The pi watchdog stopped ${who}: a pi tool ran for ${formatDuration(limits.idleMs)} with no output (idle limit), after ${ran} in total.`
        hint = 'A command pi ran looks hung. Retry, ask for a shorter command, or raise the plugin option idleTimeoutSec.'
      } else {
        head = `The pi watchdog stopped ${who}: it hit the ${formatDuration(limits.wallMs)} wall-clock cap (ran ${ran}).`
        hint = 'Split the task into smaller runs, or raise the plugin option maxRunMinutes.'
      }
      break
    case 'provider':
      head = `pi subagent ${who} failed with a provider/model error${after} after ${ran}: ${cause.message}`
      hint = isTransientError(cause.message)
        ? 'The provider looks overloaded or flaky. Retry later, add fallback models with /pi fallback add <provider/model>, or pick another model with /pi.'
        : 'Check the model id and provider sign-in (pi auth check), or pick another model with /pi.'
      break
    case 'exit':
      head = `pi subagent ${who} exited ${cause.signal !== null ? `on ${cause.signal}` : `with code ${String(cause.code)}`} after ${ran} without a final answer.`
      hint = 'See pi’s stderr below.'
      break
    case 'spawn':
      head = `Could not run ${opts.piPath ?? 'pi'} for ${who}: ${cause.message}`
      hint = 'Check that pi is installed and on PATH, or set the plugin option piPath.'
      break
  }
  const tokens = tally.input + tally.output + tally.cacheRead + tally.cacheWrite
  const lines = [
    head,
    `Partial progress: ${tally.toolCount} tool use${tally.toolCount === 1 ? '' : 's'}, ${formatTokens(tokens)} tokens${tally.cost > 0 ? `, ${formatCost(tally.cost)}` : ''}.`,
  ]
  const step = lastStep(tally)
  lines.push(`Last tool step: ${step ?? '(none)'}`)
  const partial = tally.finalText.trim() !== '' ? tally.finalText : tally.tail
  if (partial.trim() !== '') lines.push(`Partial answer so far: ${oneLine(partial, 600)}`)
  if (opts.history !== undefined && opts.history.length > 0) {
    lines.push('Earlier attempts (each resumed in a fresh pi session):', ...opts.history.map(h => `  ${h}`))
  }
  const err = stderrTail(opts.stderr)
  if (err.length > 0) lines.push('pi stderr (last 5 lines):', ...err.map(l => `  ${l}`))
  if (opts.resumeHint !== undefined) lines.push(opts.resumeHint)
  lines.push(hint)
  return lines.join('\n')
}

/**
 * Whether the bridge draws an Agent row itself: while its pi run is going.
 * Decided from the run, not the row's `isRunning`, which the terminal reports
 * false for an Agent call a plugin answers (seen in a real session), and with
 * the call's stored result as the end.
 */
export function shouldDrawLiveRow(
  run: Pick<PiRun, 'endedAt'> | undefined,
  props: { output?: unknown; isExpanded?: boolean },
): boolean {
  if (run === undefined || props.isExpanded === true) return false
  return run.endedAt === undefined && props.output === undefined
}
