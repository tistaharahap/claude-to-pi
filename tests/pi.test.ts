import { expect, test } from 'claude-code/testing'

import {
  EMPTY_SETTINGS,
  agentRecord,
  applyEvent,
  buildArgv,
  classifyEnd,
  decideBackground,
  failureMessage,
  filterModels,
  hostExposesBackground,
  lastStep,
  readOptions,
  resolveHostExposes,
  shouldDrawLiveRow,
  stderrTail,
  watchdogCheck,
  formatModel,
  newTally,
  parseLine,
  parseModelList,
  parseModelRef,
  planRun,
  takeLines,
} from '../hooks/pi'
import { FIXTURE_LINES } from './fixture'

test('model references parse provider, nested ids and thinking', async () => {
  expect(parseModelRef('openai/gpt-5.5')).toEqual({ provider: 'openai', model: 'gpt-5.5' })
  expect(parseModelRef('openrouter/anthropic/claude-x:high')).toEqual({
    provider: 'openrouter',
    model: 'anthropic/claude-x',
    thinking: 'high',
  })
  expect(parseModelRef('sonnet')).toEqual({ provider: '', model: 'sonnet' })
  expect(parseModelRef('')).toBeUndefined()
  expect(formatModel(parseModelRef('openai/gpt-5.5:low'))).toBe('openai/gpt-5.5:low')
  expect(formatModel(undefined)).toBe('pi default')
})

test('pi --list-models output becomes rows and filters by words', async () => {
  const rows = parseModelList(
    [
      'provider      model             context  max-out  thinking  images',
      'openai        gpt-5.5           272K     128K     yes       yes',
      'openrouter    qwen/qwen3-coder  262K     65K      no        no',
    ].join('\n'),
  )
  expect(rows).toEqual([
    { provider: 'openai', model: 'gpt-5.5', context: '272K', thinking: true },
    { provider: 'openrouter', model: 'qwen/qwen3-coder', context: '262K', thinking: false },
  ])
  expect(filterModels(rows, 'router coder').map(r => r.model)).toEqual(['qwen/qwen3-coder'])
})

test('a run is planned from profile, then tier, then default; effort sets thinking', async () => {
  const settings = {
    ...EMPTY_SETTINGS,
    defaultModel: { provider: 'openai', model: 'gpt-5.5' },
    tiers: { haiku: { provider: 'openai', model: 'gpt-5.4-mini' } },
    profiles: [{ name: 'qwen', model: { provider: 'openrouter', model: 'qwen/qwen3-coder' }, readOnly: true }],
  }
  expect(planRun(settings, 'agent')?.model).toEqual({ provider: 'openai', model: 'gpt-5.5' })
  expect(planRun(settings, 'agent', 'haiku')?.model?.model).toBe('gpt-5.4-mini')
  expect(planRun(settings, 'explore')?.readOnly).toBe(true)
  expect(planRun(settings, 'qwen', 'haiku')?.model?.model).toBe('qwen/qwen3-coder')
  expect(planRun(settings, 'qwen')?.readOnly).toBe(true)
  expect(planRun(settings, 'agent', undefined, 'high')?.model?.thinking).toBe('high')
  expect(planRun(settings, 'nope')).toBeUndefined()
})

test('argv asks pi for JSON, no session, the model and read-only tools', async () => {
  const argv = buildArgv({
    piPath: 'pi',
    plan: { agentType: 'pi:explore', model: { provider: 'openai', model: 'gpt-5.5', thinking: 'low' }, readOnly: true },
    prompt: '-starts with a dash',
    isolate: true,
  })
  expect(argv.slice(0, 5)).toEqual(['pi', '--print', '--mode', 'json', '--no-session'])
  expect(argv).toContain('--no-extensions')
  expect(argv).toContain('--no-skills')
  expect(argv[argv.indexOf('--model') + 1]).toBe('openai/gpt-5.5')
  expect(argv[argv.indexOf('--thinking') + 1]).toBe('low')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
  expect(argv.slice(-2)).toEqual(['--', '-starts with a dash'])
})

test('the event stream tallies tools, usage and the final answer', async () => {
  const { lines, rest } = takeLines(FIXTURE_LINES.join('\n') + '\n{"type":"partial')
  expect(rest).toBe('{"type":"partial')
  const tally = newTally()
  for (const line of lines) {
    const ev = parseLine(line)
    if (ev !== undefined) applyEvent(tally, ev)
  }
  expect(tally.toolCount).toBe(1)
  expect(tally.steps).toEqual([{ tool: 'ls', summary: 'src', isDone: true, isError: false }])
  expect(tally.finalText).toBe('Found 2 files. DONE')
  expect(tally.input).toBe(150)
  expect(tally.output).toBe(30)
  expect(tally.models).toEqual(['openai/gpt-4.1-mini'])
  expect(tally.isSettled).toBe(true)
  expect(tally.error).toBeUndefined()

  const record = agentRecord({ agentId: 'pi-1', agentType: 'pi:agent', prompt: 'p', tally, durationMs: 1234 })
  expect(record.status).toBe('completed')
  expect(record.content).toEqual([{ type: 'text', text: 'Found 2 files. DONE' }])
  expect(record.resolvedModel).toBe('pi:openai/gpt-4.1-mini')
  expect(record.totalTokens).toBe(180)
  expect(record.toolStats.searchCount).toBe(1)
})

test('an errored assistant message is the run error', async () => {
  const tally = newTally()
  applyEvent(tally, {
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 Unauthorized', usage: {} },
  })
  expect(tally.error).toBe('401 Unauthorized')
})

test('plugin options default to auto background, 180 s idle and a 30 min cap', async () => {
  expect(readOptions({})).toEqual({
    piPath: 'pi',
    isolate: true,
    background: 'auto',
    limits: { idleMs: 180_000, wallMs: 1_800_000 },
  })
  const o = readOptions({ piPath: '/bin/pi', isolate: false, background: 'Never', idleTimeoutSec: 30, maxRunMinutes: '5' })
  expect(o).toEqual({ piPath: '/bin/pi', isolate: false, background: 'never', limits: { idleMs: 30_000, wallMs: 300_000 } })
  expect(readOptions({ background: 'sometimes', idleTimeoutSec: -1, maxRunMinutes: 'x' }).background).toBe('auto')
  expect(readOptions({ idleTimeoutSec: 0 }).limits.idleMs).toBe(180_000)
})

test('auto backgrounds a run when the host Agent tool cannot ask for it', async () => {
  expect(hostExposesBackground('… using the run_in_background parameter …')).toBe(true)
  expect(hostExposesBackground('Launch a new agent')).toBe(false)
  expect(hostExposesBackground(undefined)).toBeUndefined()

  const bg = (mode: 'auto' | 'always' | 'never', flag: unknown, exposes: boolean | undefined) =>
    decideBackground(mode, flag, exposes).background
  expect(bg('auto', true, true)).toBe(true)
  expect(bg('auto', true, false)).toBe(true)
  expect(bg('auto', false, false)).toBe(false)
  expect(bg('auto', undefined, true)).toBe(false)
  expect(bg('auto', undefined, undefined)).toBe(false)
  expect(bg('auto', undefined, false)).toBe(true)
  expect(bg('always', undefined, true)).toBe(true)
  expect(bg('never', true, false)).toBe(false)
  expect(decideBackground('auto', undefined, false).reason).toContain('no run_in_background')
})

test('watchdogs: the wall-clock cap, then the idle limit', async () => {
  const limits = { idleMs: 180_000, wallMs: 1_800_000 }
  expect(watchdogCheck({ now: 179_999, startedAt: 0, lastEventAt: 0, limits })).toBeUndefined()
  expect(watchdogCheck({ now: 180_000, startedAt: 0, lastEventAt: 0, limits })).toBe('idle')
  expect(watchdogCheck({ now: 1_000_000, startedAt: 0, lastEventAt: 900_000, limits })).toBeUndefined()
  expect(watchdogCheck({ now: 1_800_000, startedAt: 0, lastEventAt: 1_799_000, limits })).toBe('wall')
})

test('a run end is told apart: watchdog, Esc, spawn, provider, bad exit', async () => {
  const t = newTally()
  expect(classifyEnd({ watchdog: 'idle', aborted: true, tally: t })).toEqual({ kind: 'watchdog', watchdog: 'idle' })
  expect(classifyEnd({ aborted: true, tally: t })).toEqual({ kind: 'user' })
  expect(classifyEnd({ aborted: false, spawnError: 'ENOENT', tally: t })).toEqual({ kind: 'spawn', message: 'ENOENT' })
  expect(classifyEnd({ aborted: false, tally: { ...t, error: '429 rate limited' } })).toEqual({
    kind: 'provider',
    message: '429 rate limited',
  })
  expect(classifyEnd({ aborted: false, tally: t, exit: { code: 1, signal: null } })).toEqual({
    kind: 'exit',
    code: 1,
    signal: null,
  })
  expect(classifyEnd({ aborted: false, tally: t, exit: { code: 0, signal: null } })).toBeUndefined()
})

test('a failure message names the model, the time, the last step and stderr', async () => {
  const tally = newTally()
  applyEvent(tally, { type: 'tool_execution_start', toolCallId: 'a', toolName: 'grep', args: { pattern: 'TODO' } })
  expect(lastStep(tally)).toBe('grep TODO (still running)')
  const stderr = ['Warning: Extension package "x": noise', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', ''].join('\n')
  expect(stderrTail(stderr)).toEqual(['l2', 'l3', 'l4', 'l5', 'l6'])
  const limits = { idleMs: 180_000, wallMs: 1_800_000 }
  const base = { agentType: 'pi:explore', model: 'openrouter/deepseek/x', elapsedMs: 200_000, limits, tally, stderr }

  const idle = failureMessage({ ...base, cause: { kind: 'watchdog', watchdog: 'idle' } })
  expect(idle).toContain('watchdog')
  expect(idle).toContain('openrouter/deepseek/x')
  expect(idle).toContain('3m 20s')
  expect(idle).toContain('Last tool step: grep TODO (still running)')
  expect(idle).toContain('  l6')
  expect(idle).not.toContain('  l1')
  expect(idle).toContain('idleTimeoutSec')
  expect(idle).not.toContain('interrupted')

  const wall = failureMessage({ ...base, cause: { kind: 'watchdog', watchdog: 'wall' } })
  expect(wall).toContain('30m 0s wall-clock cap')
  expect(wall).toContain('maxRunMinutes')

  const esc = failureMessage({ ...base, cause: { kind: 'user' } })
  expect(esc).toContain('interrupted by the user (Esc)')
  expect(esc).not.toContain('watchdog')

  const provider = failureMessage({ ...base, cause: { kind: 'provider', message: '401 Unauthorized' } })
  expect(provider).toContain('provider/model error')
  expect(provider).toContain('401 Unauthorized')
})

test('a cut-off tool.list summary never proves run_in_background is missing', async () => {
  expect(resolveHostExposes(false, 'run_in_background')).toBe(false)
  expect(resolveHostExposes(true, undefined)).toBe(true)
  expect(resolveHostExposes(undefined, 'Launch a new agent to handle complex, multi-step tasks.')).toBeUndefined()
  expect(resolveHostExposes(undefined, '… run_in_background …')).toBe(true)
})

test('the live row is drawn while the run goes, whatever the row says of isRunning', async () => {
  expect(shouldDrawLiveRow({}, {})).toBe(true)
  expect(shouldDrawLiveRow({ endedAt: 5 }, {})).toBe(false)
  expect(shouldDrawLiveRow({}, { output: { status: 'completed' } })).toBe(false)
  expect(shouldDrawLiveRow({}, { isExpanded: true })).toBe(false)
  expect(shouldDrawLiveRow(undefined, {})).toBe(false)
})
