import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PiModel, PiPicker, PiProfile, PiRun, PiSettings } from '../types'
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

type $ = EngineInterface

function piTypeOf(subagentType: unknown): string | undefined {
  return typeof subagentType === 'string' && subagentType.startsWith('pi:')
    ? subagentType.slice(3)
    : undefined
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
  for (const p of s.profiles) {
    await $.agent.register({ name: p.name, description: profileDescription(p), ...placeholder(p.name) })
  }
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
  const name = p.target.slice(8)
  await saveSettings($, {
    ...s,
    profiles: s.profiles.map(pr => (pr.name === name ? { ...pr, model } : pr)),
  })
  return `pi:${name} now runs ${formatModel(model)}`
}

function currentFor(s: PiSettings, target: string): PiModel | undefined {
  if (target === 'default') return s.defaultModel
  if (target.startsWith('tier:')) return s.tiers[target.slice(5) as keyof PiSettings['tiers']]
  return s.profiles.find(p => p.name === target.slice(8))?.model
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
}

type Pull = IteratorResult<{ stream: 'stdout' | 'stderr'; text: string }, { code: number | null; signal: string | null }>

type AttemptEnd = {
  exit?: { code: number | null; signal: string | null }
  spawnError?: string
  watchdog?: WatchdogKind
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
          if (ev !== undefined) {
            applyEvent(tally, ev)
            sawEvent = true
          }
        }
        const now = await $.clock.now()
        if (sawEvent) lastEventAt = now
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
  return { tally, durationMs, history, ...(cause !== undefined ? { cause, error } : {}) }
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
  const note = recoveryNote(out.history, ranOn)
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

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const s = normalizeSettings(await $.store.get(STORE_KEY))
    await update($, settingsAtom, () => s)
    showStatus($, s)
    await $.command.register({
      name: 'pi',
      description: 'Choose the pi provider/model for pi subagents, map tiers, manage pi agent profiles',
      argumentHint: '[status | model <provider/model[:thinking]> | tier <haiku|sonnet|opus|fable> <ref> | profile add|rm|list | fallback add|rm|clear|list | models [search]]',
      immediate: true,
    })
    await registerAgents($, s)
    return started
  })

  // ------------------------------------------------- the Agent tool, on pi

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const name = piTypeOf(e.subagent_type)
    if (name === undefined) return next(e)

    const settings = await read($, settingsAtom)
    const plan = planRun(settings, name, e.model, e.effort)
    if (plan === undefined) {
      const known = [...BUILTIN_AGENTS, ...settings.profiles.map(p => p.name)].map(n => `pi:${n}`)
      return { deny: `Unknown pi agent type "pi:${name}". Available: ${known.join(', ')}.` }
    }
    if (e.isolation !== undefined) {
      return { deny: `pi subagents do not support isolation "${e.isolation}"; call again without it.` }
    }

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

    const flag = (e as { run_in_background?: unknown }).run_in_background
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
    const note = recoveryNote(out.history, out.tally.models[out.tally.models.length - 1] ?? formatModel(plan.model))
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
      : piTypeOf((e as { subagent_type?: unknown }).subagent_type) !== undefined
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
    const input = (e.props.input ?? {}) as { subagent_type?: unknown; description?: string }
    if (piTypeOf(input.subagent_type) === undefined) return next(e)
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
      await $.ui.open({ id: PANE, title: 'pi models', focus: true, closeOnEscape: true })
      await loadModels($, piPath)
      return { text: 'Opened the pi model picker.' }
    }

    if (sub === 'status') return { text: describe(s) }
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

    if (sub === 'profile') {
      const [action, name, ref, ...more] = rest
      if (action === 'list' || action === undefined) {
        return {
          text:
            s.profiles.length === 0
              ? 'No pi profiles. Add one: /pi profile add <name> <provider/model[:thinking]> [--read-only] [description]'
              : s.profiles
                  .map(p => `pi:${p.name} → ${formatModel(p.model)}${p.readOnly ? ' (read-only)' : ''}`)
                  .join('\n'),
        }
      }
      if (action === 'rm' || action === 'remove') {
        if (name === undefined) return { text: 'Usage: /pi profile rm <name>' }
        if (!s.profiles.some(p => p.name === name)) return { text: `No pi profile named ${name}.` }
        await saveSettings($, { ...s, profiles: s.profiles.filter(p => p.name !== name) })
        return { text: `Removed pi:${name}. It leaves the agent list once this session restarts.` }
      }
      if (action === 'add') {
        if (name === undefined || ref === undefined) {
          return { text: 'Usage: /pi profile add <name> <provider/model[:thinking]> [--read-only] [description]' }
        }
        if (!isValidProfileName(name)) {
          return { text: `Profile names use letters, digits, _ and - and cannot be ${BUILTIN_AGENTS.join(' or ')}.` }
        }
        const model = parseModelRef(ref)
        if (model === undefined) return { text: `Not a model reference: ${ref}` }
        const readOnly = more.includes('--read-only')
        const words = more.filter(w => w !== '--read-only').join(' ')
        const profile: PiProfile = { name, model, readOnly, ...(words !== '' ? { description: words } : {}) }
        await saveSettings($, { ...s, profiles: [...s.profiles.filter(p => p.name !== name), profile] })
        return { text: `Added subagent type pi:${name} → ${formatModel(model)}${readOnly ? ' (read-only)' : ''}.` }
      }
      return { text: 'Usage: /pi profile <add|rm|list> …' }
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
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>{describe(s)}</Text>
          <Text dimColor>Set models with /pi model provider/model[:thinking].</Text>
        </Box>
      )
    }
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const targets = [
      { value: 'default', label: `Default (pi:agent, pi:explore) — ${formatModel(s.defaultModel)}` },
      ...TIER_ALIASES.map(a => ({ value: `tier:${a}`, label: `Agent model "${a}" — ${formatModel(s.tiers[a])}` })),
      ...s.profiles.map(pr => ({ value: `profile:${pr.name}`, label: `pi:${pr.name} — ${formatModel(pr.model)}` })),
    ]
    const matches = filterModels(p.models, p.filter)
    const room = Math.max(5, Math.min(60, e.props.scroll.bodyRows - 8))
    const shown = matches.slice(0, room)
    const current = currentFor(s, p.target)
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

function describe(s: PiSettings): string {
  const lines = [
    `pi:agent, pi:explore → ${formatModel(s.defaultModel)}`,
    ...TIER_ALIASES.filter(a => s.tiers[a] !== undefined).map(a => `Agent model "${a}" → ${formatModel(s.tiers[a])}`),
    ...s.profiles.map(p => `pi:${p.name} → ${formatModel(p.model)}${p.readOnly ? ' (read-only)' : ''}`),
    ...(s.fallbacks !== undefined && s.fallbacks.length > 0
      ? [`Fallbacks when a run stalls: ${s.fallbacks.map(m => formatModel(m)).join(' → ')}`]
      : []),
  ]
  return lines.join('\n')
}

const HELP = [
  '/pi                         open the model picker',
  '/pi status                  show which pi models the pi subagents use',
  '/pi model <ref>|reset       set the default model (ref: provider/model[:thinking])',
  '/pi <provider/model>        shorthand for /pi model',
  '/pi tier <alias> <ref>|reset  map the Agent tool’s model alias (haiku, sonnet, opus, fable) to a pi model',
  '/pi profile add <name> <ref> [--read-only] [description]   add a subagent type pi:<name>',
  '/pi profile rm <name> | list',
  '/pi fallback add <ref> …    models a stalled run moves to from its 2nd retry (rm <ref>, clear, list)',
  '/pi models [search]         open the picker filtered',
].join('\n')
