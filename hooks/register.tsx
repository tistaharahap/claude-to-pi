import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PiModel, PiPicker, PiProfile, PiRun, PiSettings } from '../types'
import {
  BUILTIN_AGENTS,
  EMPTY_SETTINGS,
  THINKING_LEVELS,
  TIER_ALIASES,
  agentRecord,
  applyEvent,
  buildArgv,
  filterModels,
  formatCost,
  formatDuration,
  formatModel,
  formatTokens,
  isValidProfileName,
  newTally,
  parseLine,
  parseModelList,
  parseModelRef,
  planRun,
  profileDescription,
  type RunPlan,
  type RunTally,
  takeLines,
  viewOf,
} from './pi'

const STORE_KEY = 'settings'
const PANE = 'pi-models'
const REDRAW_MS = 200

// Bump a shape tag whenever that value's fields change: it declines what an
// earlier version stored, which outlives a hot reload.
const settingsAtom = atom({ plugin: 'pi', key: 'settings' } as const, EMPTY_SETTINGS, {
  shape: 'settings-1',
})
const runsAtom = atom({ plugin: 'pi', key: 'runs' } as const, {}, { shape: 'runs-1' })
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
  plan: RunPlan
  prompt: string
  description: string
  runKey: string
  agentId: string
}

type PiOutcome = {
  tally: RunTally
  error?: string
  interrupted: boolean
  durationMs: number
}

const STDERR_NOISE = /^Warning: Extension package/

/**
 * Runs `pi --print --mode json` for a job, folding its event stream into a
 * tally and the live row's state; `onProgress` sees the tally as it grows.
 */
async function runPi(
  $: $,
  job: PiJob,
  signal: AbortSignal | undefined,
  onProgress?: (tally: RunTally) => Promise<void>,
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
  let stderr = ''
  let exit: { code: number | null; signal: string | null } | undefined
  let lastDraw = 0
  const argv = buildArgv({ piPath: job.piPath, plan: job.plan, prompt: job.prompt, isolate: job.isolate })

  try {
    const child = $.process.spawn({ argv, env: { PI_SUBAGENT: '1' } })
    let buffer = ''
    const iter = child[Symbol.asyncIterator]()
    for (;;) {
      const step = await iter.next()
      if (step.done === true) {
        exit = step.value
        break
      }
      const chunk = step.value
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-4000)
        continue
      }
      const { lines, rest } = takeLines(buffer + chunk.text)
      buffer = rest
      for (const line of lines) {
        const ev = parseLine(line)
        if (ev !== undefined) applyEvent(tally, ev)
      }
      const now = Date.now()
      if (now - lastDraw >= REDRAW_MS) {
        lastDraw = now
        await update($, runsAtom, runs => ({
          ...runs,
          [job.runKey]: { ...viewOf(base, tally), status: 'running' as const },
        }))
        if (onProgress !== undefined) await onProgress(tally)
      }
    }
    const ev = parseLine(buffer)
    if (ev !== undefined) applyEvent(tally, ev)
  } catch (err) {
    tally.error = signal?.aborted === true ? 'interrupted' : `Could not run ${job.piPath}: ${String(err)}`
  }

  const endedAt = await $.clock.now()
  const interrupted = signal?.aborted === true
  const failedExit = exit !== undefined && exit.code !== 0 && tally.finalText.trim() === ''
  const stderrTail = stderr
    .split('\n')
    .filter(l => l.trim() !== '' && !STDERR_NOISE.test(l))
    .slice(-5)
    .join('\n')
  const error =
    tally.error ?? (failedExit ? stderrTail || `pi exited with code ${String(exit?.code)}` : undefined)
  const status: PiRun['status'] = interrupted ? 'interrupted' : error !== undefined ? 'failed' : 'completed'
  await update($, runsAtom, runs => ({
    ...runs,
    [job.runKey]: { ...viewOf(base, tally), status, endedAt, ...(error !== undefined ? { error } : {}) },
  }))
  return { tally, interrupted, durationMs: endedAt - startedAt, ...(error !== undefined ? { error } : {}) }
}

/** Keeps the live-row map small: finished runs past the newest 20 go. */
function pruneRuns(runs: Record<string, PiRun>): Record<string, PiRun> {
  const entries = Object.entries(runs)
  if (entries.length <= 20) return runs
  return Object.fromEntries(entries.filter(([, r]) => r.endedAt === undefined).concat(entries.slice(-20)))
}

function progressReport(job: PiJob, tally: RunTally, footer: string): string {
  const steps = tally.steps.map(s => `- ${s.isError ? '✗' : s.isDone ? '✓' : '…'} ${s.tool} ${s.summary}`)
  return [
    `# ${job.plan.agentType}: ${job.description}`,
    '',
    `Model: ${tally.models[tally.models.length - 1] ?? formatModel(job.plan.model)} (via pi)`,
    '',
    '## Tool calls',
    steps.length === 0 ? '(none yet)' : steps.join('\n'),
    '',
    footer,
  ].join('\n')
}

/** A background pi subagent: progress goes to its output file, and its end
 * comes back to the session as a message, the way a background task's does. */
async function runInBackground($: $, job: PiJob, outputFile: string): Promise<void> {
  let lastWrite = 0
  const out = await runPi($, job, undefined, async tally => {
    const now = Date.now()
    if (now - lastWrite < 2000) return
    lastWrite = now
    await $.fs.write(outputFile, progressReport(job, tally, '## Status\nRunning…'))
  })
  const ok = out.error === undefined || out.tally.finalText.trim() !== ''
  const final = ok
    ? `## Final report\n\n${out.tally.finalText}`
    : `## Failed\n\n${out.error ?? 'unknown error'}`
  await $.fs.write(outputFile, progressReport(job, out.tally, final))
  const meta = `${out.tally.toolCount} tool uses, ${formatTokens(out.tally.input + out.tally.output + out.tally.cacheRead + out.tally.cacheWrite)} tokens, ${formatDuration(out.durationMs)}`
  $.ui.toast(`${job.plan.agentType} ${ok ? 'finished' : 'failed'}: ${job.description}`)
  await $.prompt.submit({
    text: ok
      ? `<task-notification>\nBackground pi subagent ${job.agentId} (${job.plan.agentType}: "${job.description}") completed on ${out.tally.models[out.tally.models.length - 1] ?? formatModel(job.plan.model)} (${meta}). Output file: ${outputFile}\n\nFinal report:\n${out.tally.finalText}\n</task-notification>`
      : `<task-notification>\nBackground pi subagent ${job.agentId} (${job.plan.agentType}: "${job.description}") failed: ${out.error ?? 'unknown error'}. Output file: ${outputFile}\n</task-notification>`,
  })
}

export const register: Register = (on, options) => {
  const piPath = typeof options.piPath === 'string' && options.piPath !== '' ? options.piPath : 'pi'
  const isolate = options.isolate !== false

  // ------------------------------------------------------------- lifecycle

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const s = normalizeSettings(await $.store.get(STORE_KEY))
    await update($, settingsAtom, () => s)
    showStatus($, s)
    await $.command.register({
      name: 'pi',
      description: 'Choose the pi provider/model for pi subagents, map tiers, manage pi agent profiles',
      argumentHint: '[status | model <provider/model[:thinking]> | tier <haiku|sonnet|opus|fable> <ref> | profile add|rm|list | models [search]]',
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

    const job: PiJob = {
      piPath,
      isolate,
      plan,
      prompt: e.prompt,
      description: e.description,
      runKey: e.tool_use_id,
      agentId: `pi-${crypto.randomUUID().slice(0, 12)}`,
    }

    if ((e as { run_in_background?: unknown }).run_in_background === true) {
      const dir = `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/claude-pi`
      const outputFile = `${dir}/${job.agentId}.md`
      await $.fs.write(outputFile, `# ${plan.agentType}: ${e.description}\n\nStarting pi (${formatModel(plan.model)})…\n`)
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
    if (out.interrupted) return { deny: 'The pi subagent was interrupted.' }
    if (out.error !== undefined && out.tally.finalText.trim() === '') {
      return { deny: `pi subagent failed (${formatModel(plan.model)}): ${out.error}` }
    }
    return {
      result: agentRecord({
        agentId: job.agentId,
        agentType: plan.agentType,
        prompt: e.prompt,
        tally: out.tally,
        durationMs: out.durationMs,
      }),
    }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : piTypeOf((e as { subagent_type?: unknown }).subagent_type) !== undefined
        ? { deny: `The pi bridge failed: ${next.error?.message ?? 'unknown error'}` }
        : next(e),
  )

  // ---------------------------------------------------- the live Agent row

  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, async ($, e, next) => {
    const input = (e.props.input ?? {}) as { subagent_type?: unknown; description?: string }
    if (piTypeOf(input.subagent_type) === undefined || e.props.isExpanded === true) return next(e)
    const runs = await read($, runsAtom)
    const run = runs[e.requestId]
    if (run === undefined || !e.props.isRunning) return next(e)

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
  '/pi models [search]         open the picker filtered',
].join('\n')
