import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PiAgentSummary, PiModel, PiPicker, PiRun, PiSettings } from '../types'
import {
  type AgentFile,
  type AgentScope,
  type PiAgentDef,
  agentFileOf,
  agentNotes,
  bridgeNote,
  chooseAgentFile,
  isPiModelRef,
  mapTools,
  parsePiAgent,
  projectAgentDirs,
  projectDirs,
  renderAgentFile,
  setAgentModel,
  skillBody,
  thinkingOf,
} from './agents'
import {
  BUILTIN_AGENTS,
  EMPTY_SETTINGS,
  THINKING_LEVELS,
  TIER_ALIASES,
  CONTINUE_PROMPT,
  agentRecord,
  applyEvent,
  attemptSummary,
  beginAttempt,
  buildArgv,
  classifyEnd,
  decideBackground,
  failureMessage,
  filterModels,
  formatCost,
  formatDuration,
  formatModel,
  formatTokens,
  hostExposesBackground,
  isRetryable,
  isValidProfileName,
  newTally,
  parseLine,
  parseModelList,
  parseModelRef,
  planRun,
  profileDescription,
  readOptions,
  recoveryNote,
  resolveHostExposes,
  retryBudget,
  retryModel,
  shouldDrawLiveRow,
  stallLimitFor,
  type FailureCause,
  type RunLimits,
  type RunPlan,
  type RunTally,
  takeLines,
  viewOf,
  watchdogCheck,
  withEffort,
  type WatchdogKind,
} from './pi'

const STORE_KEY = 'settings'
const PANE = 'pi-models'
// The live row redraws at least this often, pi output or not, so its elapsed
// time keeps ticking through a long silent model turn; the watchdogs are
// checked on the same beat.
const REDRAW_MS = 1000

// Bump a shape tag whenever that value's fields change: it declines what an
// earlier version stored, which outlives a hot reload.
const settingsAtom = atom({ plugin: 'pi', key: 'settings' } as const, EMPTY_SETTINGS, {
  shape: 'settings-2',
})
const runsAtom = atom({ plugin: 'pi', key: 'runs' } as const, {}, { shape: 'runs-3' })
// What the host's Agent tool offers, read off its full description.
const hostAtom = atom({ plugin: 'pi', key: 'host' } as const, {}, { shape: 'host-1' })
const pickerAtom = atom(
  { plugin: 'pi', key: 'picker' } as const,
  { filter: '', thinking: 'inherit', target: 'default', models: [], isLoading: false },
  { shape: 'picker-1' },
)

// The pi agents found in agent files, for /pi status, profile list and the picker.
const agentsAtom = atom({ plugin: 'pi', key: 'agents' } as const, { list: [] }, { shape: 'agents-1' })
// Where the engine says each agent type it lists comes from (agent.offer's
// `source`), so a name defined in several places resolves the way Claude Code does.
const offersAtom = atom({ plugin: 'pi', key: 'offers' } as const, {}, { shape: 'offers-1' })

type $ = EngineInterface

function piTypeOf(subagentType: unknown): string | undefined {
  return typeof subagentType === 'string' && subagentType.startsWith('pi:')
    ? subagentType.slice(3)
    : undefined
}

// ------------------------------------------------------------- agent files

async function homeDir($: $): Promise<string | undefined> {
  try {
    const home = (await $.env.get('HOME'))?.replace(/\/+$/, '')
    return home === undefined || home === '' ? undefined : home
  } catch {
    return undefined
  }
}

async function readText($: $, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/** The agent files in one folder and its subfolders, as Claude Code loads them. */
async function listAgentFiles($: $, dir: string, scope: AgentScope, depth = 0): Promise<AgentFile[]> {
  let entries: Awaited<ReturnType<$['fs']['list']>>
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const files: AgentFile[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'dir' && depth < 3) files.push(...(await listAgentFiles($, path, scope, depth + 1)))
    else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
      const text = await readText($, path)
      const file = text === undefined ? undefined : agentFileOf(text, path, scope)
      if (file !== undefined) files.push(file)
    }
  }
  return files
}

/** Every agent file Claude Code reads: the project's folders closest first, then the user's. */
async function scanAgentFiles($: $): Promise<AgentFile[]> {
  const cwd = await $.session.cwd()
  const home = await homeDir($)
  const files: AgentFile[] = []
  for (const dir of projectAgentDirs(cwd, home)) files.push(...(await listAgentFiles($, dir, 'project')))
  if (home !== undefined) files.push(...(await listAgentFiles($, `${home}/.claude/agents`, 'user')))
  return files
}

/**
 * The pi agent Claude Code would run for `name`: the agent file that wins for
 * that name, when its model is a pi model. `anySource` skips the engine's word
 * on where the name comes from (for `pi:<name>`, which the engine never lists).
 */
async function findPiAgent($: $, name: string, anySource = false): Promise<PiAgentDef | undefined> {
  const files = await scanAgentFiles($)
  const source = anySource ? undefined : (await read($, offersAtom))[name]
  const file = chooseAgentFile(files, name, source)
  if (file === undefined || !isPiModelRef(file.model)) return undefined
  return parsePiAgent(file.text, file.path, file.scope)
}

/** The pi agents among the agent files, the winning file per name, for listings. */
async function refreshAgents($: $): Promise<PiAgentSummary[]> {
  const files = await scanAgentFiles($)
  const list: PiAgentSummary[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.name)) continue
    seen.add(file.name)
    if (!isPiModelRef(file.model)) continue
    const def = parsePiAgent(file.text, file.path, file.scope)
    if (def === undefined) continue
    const tools = mapTools(def.tools, def.disallowedTools)
    list.push({
      name: def.name,
      model: def.model,
      scope: def.scope,
      path: def.path,
      readOnly: tools.readOnly,
      warnings: agentNotes({ def, unmapped: tools.unmapped, missingSkills: [] }),
    })
  }
  await update($, agentsAtom, () => ({ list }))
  return list
}

/**
 * The skills an agent file preloads, read from the project's and the user's
 * `.claude/skills/<name>/SKILL.md`, as text for pi's system prompt.
 */
async function loadSkills($: $, names: readonly string[]): Promise<{ blocks: string[]; missing: string[] }> {
  const blocks: string[] = []
  const missing: string[] = []
  if (names.length === 0) return { blocks, missing }
  const cwd = await $.session.cwd()
  const home = await homeDir($)
  const roots = [...projectDirs(cwd, home), ...(home !== undefined ? [home] : [])]
  for (const name of names) {
    let found = false
    if (/^[\w.-]+$/.test(name)) {
      for (const root of roots) {
        const dir = `${root}/.claude/skills/${name}`
        const text = await readText($, `${dir}/SKILL.md`)
        if (text === undefined) continue
        blocks.push(`# Skill: ${name}\n\n(The skill's files are in ${dir}.)\n\n${skillBody(text)}`)
        found = true
        break
      }
    }
    if (!found) missing.push(name)
  }
  return { blocks, missing }
}

/** Plans a run of a pi agent file: its model, tools, prompt, skills and limits. */
async function planAgentFile($: $, def: PiAgentDef, effort?: string): Promise<RunPlan> {
  const tools = mapTools(def.tools, def.disallowedTools)
  const skills = await loadSkills($, def.skills)
  const own = thinkingOf(def.effort)
  const base = def.model.thinking === undefined && own !== undefined ? { ...def.model, thinking: own } : def.model
  const model = withEffort(base, effort) ?? base
  const prompt = [def.prompt, ...skills.blocks].filter(p => p.trim() !== '').join('\n\n')
  const notes = agentNotes({ def, unmapped: tools.unmapped, missingSkills: skills.missing })
  return {
    agentType: def.name,
    model,
    readOnly: tools.readOnly,
    ...(tools.tools !== undefined ? { tools: tools.tools } : {}),
    ...(tools.exclude !== undefined ? { excludeTools: tools.exclude } : {}),
    mcp: tools.mcp,
    ...(prompt !== '' ? { prompt } : {}),
    ...(def.omitClaudeMd ? { noContextFiles: true } : {}),
    ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  }
}

/** What an Agent call resolves to: a pi run, a refusal, or (undefined) not pi's. */
type Target = { plan: RunPlan; background: boolean } | { deny: string }

async function targetOfDef($: $, def: PiAgentDef, effort?: string): Promise<Target> {
  if (def.isolation !== undefined) {
    return { deny: `${def.name} runs on pi, which does not support isolation "${def.isolation}" (set in ${def.path}).` }
  }
  return { plan: await planAgentFile($, def, effort), background: def.background }
}

async function resolveTarget($: $, subagentType: unknown, alias?: string, effort?: string): Promise<Target | undefined> {
  if (typeof subagentType !== 'string' || subagentType === '') return undefined
  const name = piTypeOf(subagentType)
  if (name !== undefined) {
    const settings = await read($, settingsAtom)
    const builtin = planRun(settings, name, alias, effort)
    if (builtin !== undefined) return { plan: builtin, background: false }
    // `pi:<name>` from before agent files: the profile now lives in `<name>.md`.
    const def = await findPiAgent($, name, true)
    if (def !== undefined) return targetOfDef($, def, effort)
    const known = [...BUILTIN_AGENTS.map(n => `pi:${n}`), ...(await refreshAgents($)).map(a => a.name)]
    return { deny: `Unknown pi agent type "${subagentType}". Available: ${known.join(', ')}.` }
  }
  const def = await findPiAgent($, subagentType)
  return def === undefined ? undefined : targetOfDef($, def, effort)
}

/** Writes an agent file and refreshes the listing of pi agent files. */
async function writeAgentFile($: $, path: string, text: string): Promise<void> {
  await $.fs.write(path, text)
  await refreshAgents($)
}

/**
 * Profiles an earlier version kept in the plugin's store become agent files in
 * `~/.claude/agents/`, so they stay available in every project. A name that
 * already has a file there is left alone.
 */
async function migrateProfiles($: $, s: PiSettings): Promise<PiSettings> {
  if (s.profiles.length === 0) return s
  const home = await homeDir($)
  if (home === undefined) return s
  const moved: string[] = []
  const kept: string[] = []
  for (const p of s.profiles) {
    const path = `${home}/.claude/agents/${p.name}.md`
    if (await $.fs.exists(path).catch(() => true)) {
      kept.push(p.name)
      continue
    }
    await $.fs.write(
      path,
      renderAgentFile({ name: p.name, model: p.model, readOnly: p.readOnly, description: profileDescription(p) }),
    )
    moved.push(p.name)
  }
  const next = { ...s, profiles: [] }
  await saveSettings($, next)
  if (moved.length > 0 || kept.length > 0) {
    $.ui.toast(
      `pi profiles are agent files now: ${moved.length > 0 ? `moved ${moved.join(', ')} to ~/.claude/agents/` : ''}${
        kept.length > 0 ? `${moved.length > 0 ? '; ' : ''}${kept.join(', ')} already had a file there, left as is` : ''
      }. Restart Claude Code to list them under their own names.`,
    )
  }
  return next
}

function normalizeSettings(raw: unknown): PiSettings {
  const s = (raw ?? {}) as Partial<PiSettings>
  return {
    ...(s.defaultModel !== undefined ? { defaultModel: s.defaultModel } : {}),
    tiers: s.tiers ?? {},
    profiles: Array.isArray(s.profiles) ? s.profiles : [],
    ...(Array.isArray(s.fallbacks) && s.fallbacks.length > 0 ? { fallbacks: s.fallbacks } : {}),
  }
}

// ---------------------------------------------------------------- settings

function showStatus($: $, s: PiSettings): void {
  $.ui.status(`π ${formatModel(s.defaultModel)}`)
}

async function registerAgents($: $, s: PiSettings): Promise<void> {
  const placeholder = (name: string) => ({
    // The pi plugin answers every call of this type itself; this definition
    // is what Claude Code lists. If the plugin is ever bypassed, the agent
    // says so instead of doing the work on the wrong model.
    prompt: `You stand in for the pi subagent "pi:${name}", whose bridge did not run. Reply only: "The pi bridge is unavailable; check that the pi plugin is loaded and that \`pi\` is installed."`,
    tools: ['Read'],
    model: 'haiku',
    maxTurns: 1,
    omitClaudeMd: true as const,
  })
  const tierNote = TIER_ALIASES.filter(a => s.tiers[a] !== undefined)
    .map(a => `model "${a}" → ${formatModel(s.tiers[a])}`)
    .join(', ')
  const routing =
    ` Runs on the pi coding agent (${formatModel(s.defaultModel)}), not on Claude.` +
    (tierNote === '' ? '' : ` Tiers: ${tierNote}.`) +
    ' Use when the user asks for pi or for a non-Anthropic model to do the work.'
  await $.agent.register({
    name: 'agent',
    description: `General-purpose pi subagent: researches, runs commands and edits files.${routing}`,
    ...placeholder('agent'),
  })
  await $.agent.register({
    name: 'explore',
    description: `Read-only pi subagent for searching and understanding a codebase (read, grep, find, ls).${routing}`,
    ...placeholder('explore'),
  })
}

async function saveSettings($: $, s: PiSettings, agentsChanged = true): Promise<void> {
  await $.store.set(STORE_KEY, s)
  await update($, settingsAtom, () => s)
  showStatus($, s)
  if (agentsChanged) await registerAgents($, s)
}

async function loadModels($: $, piPath: string): Promise<void> {
  await update($, pickerAtom, p => ({ ...p, isLoading: true, error: undefined }))
  try {
    const out = await $.process.run([piPath, '--list-models', '--offline'], { timeoutMs: 60_000 })
    const models = parseModelList(out.stdout)
    await update($, pickerAtom, p => ({
      ...p,
      models,
      isLoading: false,
      error: models.length === 0 ? (out.stderr.trim().split('\n').pop() ?? 'pi listed no models') : undefined,
    }))
  } catch (err) {
    await update($, pickerAtom, p => ({ ...p, isLoading: false, error: `Could not run ${piPath}: ${String(err)}` }))
  }
}

async function applyPick($: $, picked: PiModel): Promise<string> {
  const p = await read($, pickerAtom)
  const s = await read($, settingsAtom)
  const model: PiModel = p.thinking === 'inherit' ? picked : { ...picked, thinking: p.thinking }
  if (p.target === 'default') {
    await saveSettings($, { ...s, defaultModel: model })
    return `pi subagents now run on ${formatModel(model)}`
  }
  if (p.target.startsWith('tier:')) {
    const alias = p.target.slice(5) as keyof PiSettings['tiers']
    await saveSettings($, { ...s, tiers: { ...s.tiers, [alias]: model } })
    return `Agent model "${alias}" now runs ${formatModel(model)} on pi`
  }
  const agent = (await read($, agentsAtom)).list.find(a => `agent:${a.path}` === p.target)
  if (agent === undefined) return 'That pi agent is gone; reopen /pi to refresh the list.'
  const text = await readText($, agent.path)
  const updated = text === undefined ? undefined : setAgentModel(text, model)
  if (updated === undefined) return `Could not update ${agent.path}.`
  await writeAgentFile($, agent.path, updated)
  return `${agent.name} now runs ${formatModel(model)} (${agent.path})`
}

function currentFor(s: PiSettings, agents: readonly PiAgentSummary[], target: string): PiModel | undefined {
  if (target === 'default') return s.defaultModel
  if (target.startsWith('tier:')) return s.tiers[target.slice(5) as keyof PiSettings['tiers']]
  return agents.find(a => `agent:${a.path}` === target)?.model
}

/** One pi subagent run: what to run and where its live row is kept. */
type PiJob = {
  piPath: string
  isolate: boolean
  limits: RunLimits
  /** Retries after a stall or a transient provider error (0: none). */
  retries: number
  /** Models later retries move to (see retryModel). */
  fallbacks: readonly PiModel[]
  plan: RunPlan
  prompt: string
  description: string
  runKey: string
  agentId: string
  /** Where this run's pi sessions live, so a stalled attempt can be resumed. */
  sessionDir: string
}

type PiOutcome = {
  tally: RunTally
  /** Why the run ended without an answer; undefined when it answered. */
  cause?: FailureCause
  /** What the model or the notification reads when `cause` is set. */
  error?: string
  /** Attempts that failed and were retried, one line each. */
  history: string[]
  durationMs: number
  /** Set when the run was stopped at its agent file's maxTurns. */
  turnCapped?: number
}

/** The lines a finished run's report ends with: recovery, a turn cap, fields pi did not apply. */
function reportNote(job: PiJob, out: PiOutcome): string | undefined {
  const ranOn = out.tally.models[out.tally.models.length - 1] ?? formatModel(job.plan.model)
  const lines = [
    recoveryNote(out.history, ranOn),
    out.turnCapped !== undefined
      ? `[pi bridge: stopped at the agent's maxTurns (${out.turnCapped}); the answer may be partial.]`
      : undefined,
    bridgeNote(job.plan.notes ?? []),
  ].filter((l): l is string => l !== undefined)
  return lines.length === 0 ? undefined : lines.join('\n')
}

type Pull = IteratorResult<{ stream: 'stdout' | 'stderr'; text: string }, { code: number | null; signal: string | null }>

type AttemptEnd = {
  exit?: { code: number | null; signal: string | null }
  spawnError?: string
  watchdog?: WatchdogKind
  /** The run reached its maxTurns and was stopped there. */
  turnCapped?: boolean
}

/**
 * Runs a pi subagent job, folding pi's event stream into a tally and the live
 * row's state; `onProgress` sees the tally (and failed attempts) as it grows.
 *
 * Every REDRAW_MS the row is redrawn (so elapsed time ticks while pi is
 * silent) and the watchdogs are checked. When the provider stalls (no event
 * while pi waits on the model) or fails with a transient error, pi is killed
 * and the run resumes by forking the pi session the attempt left: the work
 * so far is kept, and the new session id gets a fresh route (on OpenRouter,
 * usually another upstream provider). Each retry doubles the stall limit;
 * later retries move to the fallback models. A hung tool, the wall clock,
 * Esc and other errors end the run with a named error.
 */
async function runPi(
  $: $,
  job: PiJob,
  signal: AbortSignal | undefined,
  onProgress?: (tally: RunTally, history: readonly string[]) => Promise<void>,
): Promise<PiOutcome> {
  const startedAt = await $.clock.now()
  const base: PiRun = {
    agentType: job.plan.agentType,
    description: job.description,
    model: formatModel(job.plan.model),
    startedAt,
    status: 'starting',
    steps: [],
    toolCount: 0,
    tokens: 0,
    cost: 0,
    tail: '',
  }
  await update($, runsAtom, runs => ({ ...pruneRuns(runs), [job.runKey]: base }))

  const tally = newTally()
  const history: string[] = []
  let stderr = ''
  let lastDraw = Number.NEGATIVE_INFINITY
  let hasOutput = false
  let notice: string | undefined

  const draw = async (now: number): Promise<void> => {
    lastDraw = now
    await update($, runsAtom, runs => ({
      ...runs,
      [job.runKey]: {
        ...viewOf(base, tally),
        status: hasOutput ? ('running' as const) : ('starting' as const),
        updatedAt: now,
        ...(notice !== undefined ? { notice } : {}),
      },
    }))
    if (onProgress !== undefined) await onProgress(tally, history)
  }

  /** One pi process: runs until it exits, the signal aborts, or a watchdog fires. */
  const attempt = async (argv: string[], stallMs: number): Promise<AttemptEnd> => {
    const end: AttemptEnd = {}
    let lastEventAt = await $.clock.now()
    const child = $.process.spawn({ argv, env: { PI_SUBAGENT: '1' } })
    const iter = child[Symbol.asyncIterator]()
    let tick: Promise<'tick'> | undefined
    try {
      let buffer = ''
      let pull: Promise<Pull> = iter.next() as Promise<Pull>
      for (;;) {
        tick ??= $.clock.sleep(REDRAW_MS, signal !== undefined ? { signal } : undefined).then(() => 'tick' as const)
        const got = await Promise.race([pull, tick])
        if (got === 'tick') {
          tick = undefined
          const now = await $.clock.now()
          end.watchdog = watchdogCheck({
            now,
            startedAt,
            lastEventAt,
            limits: job.limits,
            isToolRunning: tally.openTools.length > 0,
            stallMs,
          })
          if (end.watchdog !== undefined) {
            // Ending the stream kills pi. Don't wait on it: a hung child may
            // never answer the pull still pending.
            pull.catch(() => {})
            void Promise.resolve(iter.return?.({ code: null, signal: 'SIGTERM' })).catch(() => {})
            break
          }
          await draw(now)
          continue
        }
        if (got.done === true) {
          end.exit = got.value
          break
        }
        const chunk = got.value
        if (chunk.stream === 'stderr') {
          stderr = (stderr + chunk.text).slice(-4000)
          pull = iter.next() as Promise<Pull>
          continue
        }
        hasOutput = true
        const { lines, rest } = takeLines(buffer + chunk.text)
        buffer = rest
        let sawEvent = false
        for (const line of lines) {
          const ev = parseLine(line)
          if (ev === undefined) continue
          // A turn past the agent's maxTurns doesn't start: keep what the earlier turns found.
          if (ev.type === 'turn_start' && job.plan.maxTurns !== undefined && tally.turns >= job.plan.maxTurns) {
            end.turnCapped = true
            break
          }
          applyEvent(tally, ev)
          sawEvent = true
        }
        const now = await $.clock.now()
        if (sawEvent) lastEventAt = now
        if (end.turnCapped === true) {
          pull.catch(() => {})
          void Promise.resolve(iter.return?.({ code: null, signal: 'SIGTERM' })).catch(() => {})
          break
        }
        if (now - lastDraw >= REDRAW_MS) await draw(now)
        // Ask for more only once this piece is drawn.
        pull = iter.next() as Promise<Pull>
      }
      const ev = parseLine(buffer)
      if (ev !== undefined) applyEvent(tally, ev)
    } catch (err) {
      if (signal?.aborted !== true) end.spawnError = String(err)
    } finally {
      // The beat still pending rejects if the signal aborts later: nobody waits on it.
      tick?.catch(() => {})
    }
    return end
  }

  const budget = retryBudget(job.retries, job.fallbacks)
  let model = job.plan.model
  // The session the next attempt forks: the last one that holds messages.
  let resumeFrom: string | undefined
  let cause: FailureCause | undefined
  let turnCapped: number | undefined
  let stallMs = stallLimitFor(job.limits, 0)
  for (let n = 0; ; n++) {
    stallMs = stallLimitFor(job.limits, n)
    const attemptStart = await $.clock.now()
    const isResume = resumeFrom !== undefined
    const argv = buildArgv({
      piPath: job.piPath,
      plan: { ...job.plan, ...(model !== undefined ? { model } : {}) },
      prompt: isResume ? CONTINUE_PROMPT : job.prompt,
      isolate: job.isolate,
      session: isResume ? { dir: job.sessionDir, fork: resumeFrom } : { dir: job.sessionDir, id: crypto.randomUUID() },
    })
    beginAttempt(tally)
    const end = await attempt(argv, stallMs)
    if (end.turnCapped === true) {
      cause = undefined
      turnCapped = job.plan.maxTurns
      break
    }
    const attemptCause = classifyEnd({ ...end, aborted: signal?.aborted === true, tally })
    // A provider hiccup pi recovered from still leaves an answer worth keeping.
    const failed = attemptCause !== undefined && !(attemptCause.kind === 'provider' && tally.finalText.trim() !== '')
    if (!failed) {
      cause = undefined
      break
    }
    cause = attemptCause
    if (tally.sessionId !== undefined && (isResume || tally.sawMessage)) resumeFrom = tally.sessionId
    const now = await $.clock.now()
    if (!isRetryable(attemptCause) || n >= budget || now - startedAt >= job.limits.wallMs) break
    const ranOn = tally.models[tally.models.length - 1] ?? formatModel(model)
    history.push(attemptSummary({ n: n + 1, model: ranOn, cause: attemptCause, stallMs, elapsedMs: now - attemptStart }))
    model = retryModel(n + 1, job.plan.model, job.fallbacks)
    base.model = formatModel(model)
    notice = `${attemptCause.kind === 'watchdog' ? 'provider stalled' : 'provider error'} · retry ${n + 1}/${budget}${
      model !== job.plan.model ? ` on ${formatModel(model)}` : ''
    }`
    await draw(now)
  }

  const endedAt = await $.clock.now()
  const durationMs = endedAt - startedAt
  const lastModel = tally.models[tally.models.length - 1] ?? formatModel(model)
  const error =
    cause !== undefined
      ? failureMessage({
          cause,
          agentType: job.plan.agentType,
          model: lastModel,
          elapsedMs: durationMs,
          limits: job.limits,
          tally,
          stderr,
          piPath: job.piPath,
          stallMs,
          history,
          ...(resumeFrom !== undefined && cause.kind !== 'user'
            ? {
                resumeHint: `pi's session is kept: inspect or continue it with \`${job.piPath} --session-dir ${job.sessionDir} --fork ${resumeFrom}\`.`,
              }
            : {}),
        })
      : undefined
  const status: PiRun['status'] = cause?.kind === 'user' ? 'interrupted' : cause !== undefined ? 'failed' : 'completed'
  await update($, runsAtom, runs => ({
    ...runs,
    [job.runKey]: { ...viewOf(base, tally), status, endedAt, ...(error !== undefined ? { error } : {}) },
  }))
  // A finished run's sessions are of no further use; a failed run's are kept
  // so the person can pick the work up (the error says how).
  if (cause === undefined || cause.kind === 'user') await removeDir($, job.sessionDir)
  return {
    tally,
    durationMs,
    history,
    ...(cause !== undefined ? { cause, error } : {}),
    ...(turnCapped !== undefined ? { turnCapped } : {}),
  }
}

/** Removes a run's own session folder; best effort (the OS cleans temp anyway). */
async function removeDir($: $, dir: string): Promise<void> {
  if (!/\/claude-pi\/sessions\/pi-[\w-]+$/.test(dir)) return
  try {
    await $.process.run(['rm', '-rf', dir], { timeoutMs: 10_000 })
  } catch {
    // Not fatal: the folder sits in the temp directory.
  }
}

async function tempDir($: $): Promise<string> {
  try {
    return ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '') || '/tmp'
  } catch {
    return '/tmp'
  }
}

/** Whether this session's Agent tool can ask for run_in_background at all. */
async function agentExposesBackground($: $): Promise<boolean | undefined> {
  const described = (await read($, hostAtom)).agentExposesBackground
  if (described !== undefined) return described
  try {
    const agent = (await $.tool.list()).find(t => t.name === 'Agent')
    return resolveHostExposes(undefined, agent?.description)
  } catch {
    return undefined
  }
}

/** Keeps the live-row map small: finished runs past the newest 20 go. */
function pruneRuns(runs: Record<string, PiRun>): Record<string, PiRun> {
  const entries = Object.entries(runs)
  if (entries.length <= 20) return runs
  return Object.fromEntries(entries.filter(([, r]) => r.endedAt === undefined).concat(entries.slice(-20)))
}

function progressReport(job: PiJob, tally: RunTally, history: readonly string[], footer: string): string {
  const steps = tally.steps.map(s => `- ${s.isError ? '✗' : s.isDone ? '✓' : '…'} ${s.tool} ${s.summary}`)
  return [
    `# ${job.plan.agentType}: ${job.description}`,
    '',
    `Model: ${tally.models[tally.models.length - 1] ?? formatModel(job.plan.model)} (via pi)`,
    '',
    '## Tool calls',
    steps.length === 0 ? '(none yet)' : steps.join('\n'),
    '',
    ...(history.length > 0
      ? ['## Retries', ...history.map(h => `- ${h}; resumed in a fresh pi session`), '']
      : []),
    footer,
  ].join('\n')
}

/** A background pi subagent: progress goes to its output file, and its end
 * comes back to the session as a message, the way a background task's does. */
async function runInBackground($: $, job: PiJob, outputFile: string): Promise<void> {
  let lastWrite = 0
  const out = await runPi($, job, undefined, async (tally, history) => {
    const now = Date.now()
    if (now - lastWrite < 2000) return
    lastWrite = now
    await $.fs.write(outputFile, progressReport(job, tally, history, '## Status\nRunning…'))
  })
  const ok = out.error === undefined
  const ranOn = out.tally.models[out.tally.models.length - 1] ?? formatModel(job.plan.model)
  const note = reportNote(job, out)
  const final = ok
    ? `## Final report\n\n${out.tally.finalText}${note !== undefined ? `\n\n${note}` : ''}`
    : `## Failed\n\n${out.error ?? 'unknown error'}`
  await $.fs.write(outputFile, progressReport(job, out.tally, out.history, final))
  const meta = `${out.tally.toolCount} tool uses, ${formatTokens(out.tally.input + out.tally.output + out.tally.cacheRead + out.tally.cacheWrite)} tokens, ${formatDuration(out.durationMs)}`
  $.ui.toast(`${job.plan.agentType} ${ok ? 'finished' : 'failed'}: ${job.description}`)
  await $.prompt.submit({
    text: ok
      ? `<task-notification>\nBackground pi subagent ${job.agentId} (${job.plan.agentType}: "${job.description}") completed on ${ranOn} (${meta}). Output file: ${outputFile}\n\nFinal report:\n${out.tally.finalText}${note !== undefined ? `\n\n${note}` : ''}\n</task-notification>`
      : `<task-notification>\nBackground pi subagent ${job.agentId} (${job.plan.agentType}: "${job.description}") failed. Output file: ${outputFile}\n\n${out.error ?? 'unknown error'}\n</task-notification>`,
  })
}

export const register: Register = (on, options) => {
  const { piPath, isolate, background, limits, retries } = readOptions(options)

  // ------------------------------------------------------------- lifecycle

  // Agent calls this bridge answers, so its error handler knows them.
  const claimed = new Set<string>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let s = normalizeSettings(await $.store.get(STORE_KEY))
    await update($, settingsAtom, () => s)
    showStatus($, s)
    await $.command.register({
      name: 'pi',
      description: 'Choose the pi provider/model for pi subagents, map tiers, write pi agent files',
      argumentHint: '[status | model <provider/model[:thinking]> | tier <haiku|sonnet|opus|fable> <ref> | profile add|rm|list | fallback add|rm|clear|list | models [search]]',
      immediate: true,
    })
    await registerAgents($, s)
    try {
      s = await migrateProfiles($, s)
      await refreshAgents($)
    } catch (err) {
      $.ui.log(`pi: could not read agent files: ${String(err)}`, { to: 'debug' })
    }
    return started
  })

  // ------------------------------------------------- the Agent tool, on pi

  // Where each agent type the model is offered comes from: an agent file in
  // the project or the user's folder, or somewhere the bridge can't read.
  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    try {
      const offers = await read($, offersAtom)
      if (offers[e.agent] !== e.source) await update($, offersAtom, o => ({ ...o, [e.agent]: e.source }))
    } catch {
      // Only a hint for resolving names; never worth failing the listing over.
    }
    return offered
  })

  // Only the Agent tool reaches the bridge. A pi agent started any other way
  // (a workflow's agent(), a teammate, another plugin's spawn) would run on
  // Claude with a model the API refuses, so it is refused here with the reason.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork) return next(e)
    const type = e.subagentType
    // Every subagent passes through here: a failed lookup must not block them.
    const isPi = piTypeOf(type) !== undefined || (await findPiAgent($, type).catch(() => undefined)) !== undefined
    if (!isPi) return next(e)
    return {
      deny: `${type} runs on pi, and only the Agent tool can start a pi agent. Call the Agent tool with subagent_type "${type}" instead (not a workflow agent or a teammate).`,
    }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const target = await resolveTarget($, e.subagent_type, e.model, e.effort)
    if (target === undefined) return next(e)
    if ('deny' in target) return { deny: target.deny }
    claimed.add(e.tool_use_id)
    const { plan } = target
    if (e.isolation !== undefined) {
      return { deny: `${plan.agentType} runs on pi, which does not support isolation "${e.isolation}"; call again without it.` }
    }
    const settings = await read($, settingsAtom)

    const agentId = `pi-${crypto.randomUUID().slice(0, 12)}`
    const tmp = await tempDir($)
    const job: PiJob = {
      piPath,
      isolate,
      limits,
      retries,
      fallbacks: settings.fallbacks ?? [],
      plan,
      prompt: e.prompt,
      description: e.description,
      runKey: e.tool_use_id,
      agentId,
      sessionDir: `${tmp}/claude-pi/sessions/${agentId}`,
    }

    // An agent file with `background: true` always runs in the background, as in Claude Code.
    const flag = target.background ? true : (e as { run_in_background?: unknown }).run_in_background
    const mode = decideBackground(
      background,
      flag,
      background === 'auto' && flag === undefined ? await agentExposesBackground($) : undefined,
    )
    if (mode.background) {
      const dir = `${tmp}/claude-pi`
      const outputFile = `${dir}/${job.agentId}.md`
      await $.fs.write(outputFile, `# ${plan.agentType}: ${e.description}\n\nStarting pi (${formatModel(plan.model)}) in the background: ${mode.reason}.\n`)
      void runInBackground($, job, outputFile).catch(err => {
        $.ui.toast(`${plan.agentType} failed to report back: ${String(err)}`)
      })
      return {
        result: {
          status: 'async_launched' as const,
          isAsync: true as const,
          agentId: job.agentId,
          description: e.description,
          prompt: e.prompt,
          outputFile,
          canReadOutputFile: true,
          canContinueAgent: false,
          resolvedModel: `pi:${formatModel(plan.model)}`,
        },
      }
    }

    const out = await runPi($, job, next.signal)
    if (out.error !== undefined) return { deny: out.error }
    const note = reportNote(job, out)
    return {
      result: agentRecord({
        agentId: job.agentId,
        agentType: plan.agentType,
        prompt: e.prompt,
        tally: out.tally,
        durationMs: out.durationMs,
        ...(note !== undefined ? { note } : {}),
      }),
    }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : piTypeOf((e as { subagent_type?: unknown }).subagent_type) !== undefined || claimed.has(e.tool_use_id)
        ? { deny: `The pi bridge failed: ${next.error?.message ?? 'unknown error'}` }
        : next(e),
  )

  // The engine computes the Agent tool's description (with or without the
  // run_in_background paragraph) before the model sees it: note which.
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const described = await next(e)
    const exposes = hostExposesBackground(described.description)
    const host = await read($, hostAtom)
    if (host.agentExposesBackground !== exposes) await update($, hostAtom, () => ({ agentExposesBackground: exposes }))
    return described
  })

  // ---------------------------------------------------- the live Agent row

  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, async ($, e, next) => {
    // Rows of pi runs only: the bridge keeps a run for each Agent call it answers.
    const run = (await read($, runsAtom))[e.requestId]
    if (run === undefined || !shouldDrawLiveRow(run, e.props)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const elapsed = formatDuration((await $.clock.now()) - run.startedAt)
    const meta = [
      `${run.toolCount} tool use${run.toolCount === 1 ? '' : 's'}`,
      `${formatTokens(run.tokens)} tokens`,
      formatCost(run.cost),
      elapsed,
    ]
      .filter(x => x !== '')
      .join(' · ')
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{run.agentType}</Text>({run.description}) <Text dimColor>π {run.model}</Text>
        </Text>
        {run.steps.map((s, i) => (
          <Text dimColor={s.isDone}>
            {i === 0 ? '  ⎿  ' : '     '}
            <Text color={s.isError ? 'red' : undefined}>{s.tool}</Text> {s.summary}
          </Text>
        ))}
        {run.tail !== '' && <Text dimColor>{`     ${run.tail}`}</Text>}
        {run.notice !== undefined && <Text color="yellow">{`     ⟳ ${run.notice}`}</Text>}
        <Text dimColor>{`     ${run.status === 'starting' ? 'Starting pi… · ' : ''}${meta}`}</Text>
      </Box>
    )
  })

  // ---------------------------------------------------------- /pi command

  on('command.run', { command: 'pi' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(a => a !== '')
    const [sub, ...rest] = args
    const s = await read($, settingsAtom)

    if (sub === undefined || sub === 'models' || sub === 'pick') {
      await update($, pickerAtom, p => ({ ...p, filter: rest.join(' ') }))
      await refreshAgents($)
      await $.ui.open({ id: PANE, title: 'pi models', focus: true, closeOnEscape: true })
      await loadModels($, piPath)
      return { text: 'Opened the pi model picker.' }
    }

    if (sub === 'status') {
      const agents = await refreshAgents($)
      return { text: describe(s, agents, await $.session.cwd(), await homeDir($)) }
    }
    if (sub === 'help') return { text: HELP }

    if (sub === 'model') {
      const ref = rest[0]
      if (ref === undefined) return { text: `Default pi model: ${formatModel(s.defaultModel)}` }
      if (ref === 'reset') {
        const { defaultModel: _, ...without } = s
        await saveSettings($, without)
        return { text: 'pi subagents now use pi’s own default model.' }
      }
      const model = parseModelRef(ref)
      if (model === undefined) return { text: `Not a model reference: ${ref}` }
      await saveSettings($, { ...s, defaultModel: model })
      return { text: `pi subagents now run on ${formatModel(model)}.` }
    }

    if (sub === 'tier') {
      const [alias, ref] = rest
      if (alias === undefined || !(TIER_ALIASES as readonly string[]).includes(alias)) {
        return { text: `Usage: /pi tier <${TIER_ALIASES.join('|')}> <provider/model[:thinking]|reset>` }
      }
      const tiers = { ...s.tiers }
      if (ref === undefined || ref === 'reset') delete tiers[alias as keyof typeof tiers]
      else {
        const model = parseModelRef(ref)
        if (model === undefined) return { text: `Not a model reference: ${ref}` }
        tiers[alias as keyof typeof tiers] = model
      }
      await saveSettings($, { ...s, tiers })
      const now = tiers[alias as keyof typeof tiers]
      return {
        text:
          now === undefined
            ? `Agent model "${alias}" no longer maps to a pi model.`
            : `Agent calls on pi types with model "${alias}" now run ${formatModel(now)}.`,
      }
    }

    if (sub === 'profile' || sub === 'profiles') {
      const flags = rest.filter(w => w.startsWith('--'))
      const [action, name, ref, ...more] = rest.filter(w => !w.startsWith('--'))
      const isUser = flags.includes('--user')
      const readOnly = flags.includes('--read-only')
      const cwd = await $.session.cwd()
      const home = await homeDir($)
      if (action === 'list' || action === undefined) {
        const agents = await refreshAgents($)
        return {
          text:
            agents.length === 0
              ? `No pi agents yet. Add one: ${PROFILE_USAGE}`
              : agents.map(a => agentLine(a, cwd, home)).join('\n'),
        }
      }
      if (action === 'rm' || action === 'remove') {
        if (name === undefined) return { text: 'Usage: /pi profile rm <name> [--user]' }
        const files = await scanAgentFiles($)
        const file = files.find(f => f.name === name && (isUser ? f.scope === 'user' : true))
        if (file === undefined) return { text: `No agent file named ${name}${isUser ? ' in ~/.claude/agents' : ''}.` }
        if (!isPiModelRef(file.model)) {
          return { text: `${shortPath(file.path, cwd, home)} is not a pi agent (its model is not pi:…); edit or delete it yourself.` }
        }
        await $.process.run(['rm', '-f', '--', file.path], { timeoutMs: 10_000 })
        await refreshAgents($)
        return { text: `Removed ${shortPath(file.path, cwd, home)}. ${name} leaves the agent list once Claude Code reloads its agents (restart the session if it is still listed).` }
      }
      if (action === 'add') {
        if (name === undefined || ref === undefined) return { text: `Usage: ${PROFILE_USAGE}` }
        if (!isValidProfileName(name)) {
          return { text: `Agent names here use letters, digits, _ and - and cannot be ${BUILTIN_AGENTS.join(' or ')}.` }
        }
        const model = parseModelRef(ref.replace(/^pi:/, ''))
        if (model === undefined) return { text: `Not a model reference: ${ref}` }
        if (isUser && home === undefined) return { text: 'Could not find your home folder for --user.' }
        const dir = isUser ? `${home}/.claude/agents` : `${cwd}/.claude/agents`
        const path = `${dir}/${name}.md`
        if (await $.fs.exists(path).catch(() => false)) {
          return { text: `${shortPath(path, cwd, home)} already exists. Edit it, or remove it first with /pi profile rm ${name}${isUser ? ' --user' : ''}.` }
        }
        const words = more.join(' ').trim()
        const description =
          words !== ''
            ? `${words}${/[.!?]$/.test(words) ? '' : '.'} Runs on pi (${formatModel(model)}).`
            : profileDescription({ name, model, readOnly })
        await writeAgentFile($, path, renderAgentFile({ name, model, readOnly, description }))
        const others = (await scanAgentFiles($)).filter(f => f.name === name && f.path !== path)
        const shadow =
          others.length > 0 ? ` Another agent file also defines ${name} (${others.map(f => shortPath(f.path, cwd, home)).join(', ')}); Claude Code uses the project's over the user's.` : ''
        return {
          text: `Wrote ${shortPath(path, cwd, home)}: the subagent type ${name} runs on pi (${formatModel(model)})${readOnly ? ', read-only' : ''}. Claude Code lists it once it reloads its agents (restart the session if it doesn't show yet).${shadow}`,
        }
      }
      return { text: `Usage: ${PROFILE_USAGE} | /pi profile rm <name> [--user] | /pi profile list` }
    }

    if (sub === 'fallback' || sub === 'fallbacks') {
      const [action, ...refs] = rest
      const list = s.fallbacks ?? []
      const save = async (next: PiModel[]) => {
        const { fallbacks: _, ...without } = s
        await saveSettings($, next.length > 0 ? { ...without, fallbacks: next } : without, false)
      }
      if (action === undefined || action === 'list') {
        return {
          text:
            list.length === 0
              ? 'No fallback models. A stalled pi run is retried on its own model; add fallbacks with /pi fallback add <provider/model[:thinking]> …'
              : `When a pi run stalls, retry 1 keeps its model, then: ${list.map(m => formatModel(m)).join(' → ')}`,
        }
      }
      if (action === 'clear') {
        await save([])
        return { text: 'Fallback models cleared.' }
      }
      if (action === 'add' || action === 'rm' || action === 'remove') {
        if (refs.length === 0) return { text: `Usage: /pi fallback ${action} <provider/model[:thinking]> …` }
        const models: PiModel[] = []
        for (const ref of refs) {
          const m = parseModelRef(ref)
          if (m === undefined) return { text: `Not a model reference: ${ref}` }
          models.push(m)
        }
        const same = (a: PiModel, b: PiModel) => formatModel(a) === formatModel(b)
        const next =
          action === 'add'
            ? [...list.filter(f => !models.some(m => same(f, m))), ...models]
            : list.filter(f => !models.some(m => same(f, m)))
        await save(next)
        return {
          text:
            next.length === 0
              ? 'No fallback models left.'
              : `Fallback models: ${next.map(m => formatModel(m)).join(' → ')}`,
        }
      }
      return { text: 'Usage: /pi fallback <add|rm|clear|list> [provider/model[:thinking] …]' }
    }

    // `/pi openai/gpt-5.5` is shorthand for `/pi model openai/gpt-5.5`.
    const model = parseModelRef(sub)
    if (model !== undefined && rest.length === 0 && sub.includes('/')) {
      await saveSettings($, { ...s, defaultModel: model })
      return { text: `pi subagents now run on ${formatModel(model)}.` }
    }
    return { text: HELP }
  })

  // ------------------------------------------------------ the model picker

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p: PiPicker = await read($, pickerAtom)
    const s = await read($, settingsAtom)
    const agents = (await read($, agentsAtom)).list
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>{describe(s, agents, await $.session.cwd(), await homeDir($))}</Text>
          <Text dimColor>Set models with /pi model provider/model[:thinking].</Text>
        </Box>
      )
    }
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const targets = [
      { value: 'default', label: `Default (pi:agent, pi:explore) — ${formatModel(s.defaultModel)}` },
      ...TIER_ALIASES.map(a => ({ value: `tier:${a}`, label: `Agent model "${a}" — ${formatModel(s.tiers[a])}` })),
      ...agents.map(a => ({ value: `agent:${a.path}`, label: `${a.name} (${a.scope} agent file) — ${formatModel(a.model)}` })),
    ]
    const matches = filterModels(p.models, p.filter)
    const room = Math.max(5, Math.min(60, e.props.scroll.bodyRows - 8))
    const shown = matches.slice(0, room)
    const current = currentFor(s, agents, p.target)
    const currentValue = current === undefined ? undefined : `${current.provider}/${current.model}`
    return (
      <Box flexDirection="column">
        <Select
          key="target"
          label="Set model for "
          value={p.target}
          options={targets}
          onSelect={(v: string) => void update($, pickerAtom, x => ({ ...x, target: v }))}
        />
        <Select
          key="thinking"
          label="Thinking "
          value={p.thinking}
          options={[{ value: 'inherit', label: 'pi default' }, ...THINKING_LEVELS.map(t => ({ value: t }))]}
          onSelect={(v: string) => void update($, pickerAtom, x => ({ ...x, thinking: v }))}
        />
        <Input
          key="filter"
          label="Filter "
          placeholder="provider or model, e.g. openai 5.5"
          value={p.filter}
          autoFocus
          submitLabel="filter"
          onInput={(v: string) => void update($, pickerAtom, x => ({ ...x, filter: v }))}
          onSubmit={(v: string) => void update($, pickerAtom, x => ({ ...x, filter: v }))}
        />
        {p.isLoading && <Text dimColor>Loading models from pi…</Text>}
        {p.error !== undefined && <Text color="red">{p.error}</Text>}
        {!p.isLoading && p.error === undefined && (
          <Text dimColor>
            {matches.length} model{matches.length === 1 ? '' : 's'}
            {matches.length > shown.length ? `, first ${shown.length} shown — type to narrow` : ''}
            {' — Tab to a model, Enter to use it'}
          </Text>
        )}
        {shown.length > 0 && (
          <Box flexDirection="column">
            {shown.map(m => {
              const id = `${m.provider}/${m.model}`
              const isCurrent = id === currentValue
              return (
                <Button
                  key={`m:${id}`}
                  plain
                  onPress={() => {
                    const picked = parseModelRef(id)
                    if (picked === undefined) return
                    void applyPick($, picked).then(msg => $.ui.toast(msg))
                  }}
                >
                  {isCurrent ? '● ' : '  '}
                  {id} <Text dimColor>{`${m.context}${m.thinking ? ' · thinking' : ''}`}</Text>
                </Button>
              )
            })}
          </Box>
        )}
        <Box>
          <Button key="refresh" label="Refresh" onPress={() => void loadModels($, piPath)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

/** A path as the person reads it: relative to the project, or under `~`. */
function shortPath(path: string, cwd: string, home?: string): string {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  if (home !== undefined && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

function agentLine(a: PiAgentSummary, cwd: string, home?: string): string {
  const head = `${a.name} → ${formatModel(a.model)}${a.readOnly ? ' (read-only)' : ''} · ${shortPath(a.path, cwd, home)}`
  return [head, ...a.warnings.map(w => `    ⚠ ${w}`)].join('\n')
}

function describe(s: PiSettings, agents: readonly PiAgentSummary[], cwd: string, home?: string): string {
  const lines = [
    `pi:agent, pi:explore → ${formatModel(s.defaultModel)}`,
    ...TIER_ALIASES.filter(a => s.tiers[a] !== undefined).map(a => `Agent model "${a}" → ${formatModel(s.tiers[a])}`),
    ...(agents.length > 0 ? ['Agent files on pi:', ...agents.map(a => `  ${agentLine(a, cwd, home)}`)] : []),
    ...(s.fallbacks !== undefined && s.fallbacks.length > 0
      ? [`Fallbacks when a run stalls: ${s.fallbacks.map(m => formatModel(m)).join(' → ')}`]
      : []),
  ]
  return lines.join('\n')
}

const PROFILE_USAGE = '/pi profile add <name> <provider/model[:thinking]> [--read-only] [--user] [description]'

const HELP = [
  '/pi                         open the model picker',
  '/pi status                  show which pi models the pi subagents and pi agent files use',
  '/pi model <ref>|reset       set the default model (ref: provider/model[:thinking])',
  '/pi <provider/model>        shorthand for /pi model',
  '/pi tier <alias> <ref>|reset  map the Agent tool’s model alias (haiku, sonnet, opus, fable) to a pi model',
  `${PROFILE_USAGE}`,
  '                            write .claude/agents/<name>.md (--user: ~/.claude/agents/) with model: pi:<ref>',
  '/pi profile rm <name> [--user] | list   remove or list pi agent files',
  '/pi fallback add <ref> …    models a stalled run moves to from its 2nd retry (rm <ref>, clear, list)',
  '/pi models [search]         open the picker filtered',
  'Any agent file in .claude/agents/ or ~/.claude/agents/ with model: pi:<provider>/<model> runs on pi.',
].join('\n')
