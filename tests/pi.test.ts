import { expect, test } from 'claude-code/testing'

import {
  EMPTY_SETTINGS,
  agentRecord,
  applyEvent,
  buildArgv,
  filterModels,
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
