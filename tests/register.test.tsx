import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FIXTURE_LINES } from './fixture'

// Stands for the engine beneath the plugin: registrations succeed.
function engine(on: On) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('agent.register', (_, e) => ({ value: { agent: `pi:${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  return mock.clock(on, { now: 1_000 })
}

test('a pi:* Agent call runs pi and answers with a completed Agent record', async ($, on) => {
  engine(on)
  mock.store(on, { settings: { defaultModel: { provider: 'openai', model: 'gpt-4.1-mini' }, tiers: {}, profiles: [] } })
  const spawned: string[][] = []
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    // pi writes in arbitrary pieces: split a line across two chunks.
    const all = FIXTURE_LINES.join('\n') + '\n'
    yield { stream: 'stderr' as const, text: 'Warning: Extension package "builtin:mcp": noise\n' }
    yield { stream: 'stdout' as const, text: all.slice(0, 101) }
    yield { stream: 'stdout' as const, text: all.slice(101) }
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', () => ({ result: 'claude ran it' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({
    tool: 'Agent',
    description: 'List src',
    prompt: 'list src',
    subagent_type: 'pi:explore',
  })

  expect(ran.deny).toBeUndefined()
  const record = ran.result as { status: string; content: { text: string }[]; agentType: string; totalToolUseCount: number }
  expect(record.status).toBe('completed')
  expect(record.agentType).toBe('pi:explore')
  expect(record.content[0]?.text).toBe('Found 2 files. DONE')
  expect(record.totalToolUseCount).toBe(1)

  const argv = spawned[0] ?? []
  expect(argv[0]).toBe('pi')
  expect(argv[argv.indexOf('--model') + 1]).toBe('openai/gpt-4.1-mini')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
})

test('a failing pi run is an error the model reads', async ($, on) => {
  engine(on)
  mock.store(on)
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'Error: Model "nosuch/model" not found.\n' }
    return { value: { code: 1, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:agent' })
  expect(ran.deny).toContain('Model "nosuch/model" not found')
})

test('other Agent calls go to Claude Code untouched', async ($, on) => {
  engine(on)
  mock.store(on)
  on('tool.call', () => ({ result: 'claude ran it' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'Explore' })
  expect(ran.result).toBe('claude ran it')
})

test('an unknown pi type is refused with the list of known ones', async ($, on) => {
  engine(on)
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:nope' })
  expect(ran.deny).toContain('pi:agent, pi:explore')
})

test('/pi model, tier and profile commands persist settings', async ($, on) => {
  engine(on)
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const pi = (args: string) =>
    $.command.run({
      command: 'pi',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })

  const set = await pi('model openai/gpt-5.5:high')
  expect(set.text).toBe('pi subagents now run on openai/gpt-5.5:high.')

  await pi('tier haiku openai/gpt-5.4-mini')
  const added = await pi('profile add qwen openrouter/qwen/qwen3-coder --read-only Fast code search')
  expect(added.text).toBe('Added subagent type pi:qwen → openrouter/qwen/qwen3-coder (read-only).')

  const status = await pi('status')
  expect(status.text).toContain('pi:agent, pi:explore → openai/gpt-5.5:high')
  expect(status.text).toContain('Agent model "haiku" → openai/gpt-5.4-mini')
  expect(status.text).toContain('pi:qwen → openrouter/qwen/qwen3-coder (read-only)')

  const listed = await pi('profile list')
  expect(listed.text).toBe('pi:qwen → openrouter/qwen/qwen3-coder (read-only)')
})

test('a background pi run launches at once, then reports back like a task', async ($, on) => {
  engine(on)
  mock.store(on)
  mock.env(on, { TMPDIR: '/tmp/' })
  const files: Record<string, string> = {}
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  on('process.spawn', async function* () {
    await gate
    yield { stream: 'stdout' as const, text: FIXTURE_LINES.join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  let notified = (_: string) => {}
  const notice = new Promise<string>(r => (notified = r))
  on('prompt.submit', (_, e) => {
    notified(e.text)
    return { value: { isQueued: true } } as never
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({
    tool: 'Agent',
    description: 'List src',
    prompt: 'list src',
    subagent_type: 'pi:agent',
    run_in_background: true,
  } as never)
  const launched = ran.result as { status: string; outputFile: string; agentId: string }
  expect(launched.status).toBe('async_launched')
  expect(launched.outputFile).toMatch(/^\/tmp\/claude-pi\/pi-.+\.md$/)

  release()
  const text = await notice
  expect(text).toContain(`Background pi subagent ${launched.agentId}`)
  expect(text).toContain('Found 2 files. DONE')
  expect(files[launched.outputFile]).toContain('## Final report')
})

test('a running pi call draws its live row; other rows are the engine’s', async ($, on) => {
  engine(on)
  mock.store(on)
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  let started = () => {}
  const isStarted = new Promise<void>(r => (started = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: FIXTURE_LINES.slice(0, 7).join('\n') + '\n' }
    started()
    await gate
    yield { stream: 'stdout' as const, text: FIXTURE_LINES.slice(7).join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const call = $.tool.call({
    tool: 'Agent',
    description: 'List src',
    prompt: 'list src',
    subagent_type: 'pi:explore',
    tool_use_id: 'toolu_1',
  } as never)
  await isStarted

  // Mounted while pi is mid-run (the spawn is held at the gate).
  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pi',
      surface,
      component: 'ToolUse',
      requestId: 'toolu_1',
      props: {
        tool_use_id: 'toolu_1',
        tool: 'Agent',
        input: { subagent_type: 'pi:explore', description: 'List src', prompt: 'list src' },
        isRunning: true,
        isErrored: false,
        isInterrupted: false,
      },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('pi:explore')
    expect(drawn).toContain('openai/gpt-4.1-mini')
    expect(drawn).toContain('"ls"')
    expect(drawn).toContain('1 tool use')
    expect(drawn).not.toContain('m ')
    await ui.unmount()

    const other = await $.ui.mount({
      plugin: 'pi',
      surface,
      component: 'ToolUse',
      requestId: 'toolu_2',
      props: {
        tool_use_id: 'toolu_2',
        tool: 'Agent',
        input: { subagent_type: 'Explore', description: 'x', prompt: 'x' },
        isRunning: true,
        isErrored: false,
        isInterrupted: false,
      },
    })
    expect(JSON.stringify(await other.drawn())).toContain('engine')
    await other.unmount()
  }
  release()
  await call
})

test('the picker pane lists pi models and sets the default on a pick', async ($, on) => {
  engine(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: [
        'provider  model        context  max-out  thinking  images',
        'openai    gpt-5.5      272K     128K     yes       yes',
        'openai    gpt-5.4-mini 400K     128K     yes       yes',
      ].join('\n'),
      stderr: '',
    },
  }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'pi',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({
    plugin: 'pi',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pi-models',
    props: {
      title: 'pi models',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: /2 models/ })).toBeDefined()
  await ui.press({ key: 'm:openai/gpt-5.4-mini' })
  await ui.unmount()

  const status = await $.command.run({
    command: 'pi',
    args: 'status',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(status.text).toContain('pi:agent, pi:explore → openai/gpt-5.4-mini')
})

// ------------------------------------------------ never looking frozen

type Clock = ReturnType<typeof mock.clock>

const toolStart = (i: number) =>
  JSON.stringify({ type: 'tool_execution_start', toolCallId: `c${i}`, toolName: 'grep', args: { pattern: `p${i}` } })
const toolEnd = (i: number) =>
  JSON.stringify({ type: 'tool_execution_end', toolCallId: `c${i}`, toolName: 'grep', isError: false })
const finalAnswer = (text: string) =>
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      stopReason: 'stop',
    },
  })

/** A slow pi: one tool call every `everyMs` on the mocked clock for `forMs`, then an answer. */
function slowPi(on: On, clock: Clock, opts: { everyMs: number; forMs: number }) {
  const spawned: string[][] = []
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    const n = Math.floor(opts.forMs / opts.everyMs)
    for (let i = 1; i <= n; i++) {
      await clock.sleep(opts.everyMs)
      yield { stream: 'stdout' as const, text: `${toolStart(i)}\n${toolEnd(i)}\n` }
    }
    yield { stream: 'stdout' as const, text: `${finalAnswer('slow DONE')}\n` }
    return { value: { code: 0, signal: null } }
  })
  return spawned
}

/** A pi that prints one event, then hangs until the bridge kills it. */
function hungPi(on: On, opts: { stderr?: string } = {}) {
  const killed: boolean[] = []
  on('process.spawn', async function* (_, _e, next) {
    if (opts.stderr !== undefined) yield { stream: 'stderr' as const, text: opts.stderr }
    yield { stream: 'stdout' as const, text: `${toolStart(1)}\n` }
    try {
      await new Promise<void>(resolve => {
        if (next.signal.aborted) resolve()
        next.signal.addEventListener('abort', () => resolve())
      })
    } finally {
      killed.push(true)
    }
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  return killed
}

/** A pi that prints one event, stays silent for `silentMs`, then answers. */
function silentPi(on: On, clock: Clock, silentMs: number) {
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${toolStart(1)}\n${toolEnd(1)}\n` }
    await clock.sleep(silentMs)
    yield { stream: 'stdout' as const, text: `${finalAnswer('thought hard DONE')}\n` }
    return { value: { code: 0, signal: null } }
  })
}

// The real terminal raises a plugin-answered Agent row with isRunning false
// while the call runs (seen in a real background-job session), so the rows
// here are mounted that way.
const rowProps = (id: string) => ({
  tool_use_id: id,
  tool: 'Agent',
  input: { subagent_type: 'pi:explore', description: `Review ${id}`, prompt: 'review the repo' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
})

async function mountRow($: Engine, id: string) {
  return $.ui.mount({
    plugin: 'pi',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: rowProps(id),
  } as never)
}

// The host's Agent tool: its full description (tool.describe, which the
// test raises as the engine does) and the 300-character summary tool.list
// gives, which is cut before the run_in_background paragraph.
const AGENT_HEAD = 'Launch a new agent to handle complex, multi-step tasks. '.padEnd(300, '.')
function hostAgentHooks(on: On) {
  on('tool.list', () => ({ value: [{ name: 'Agent', mcp: false, description: AGENT_HEAD }] }))
  on('tool.describe', (_, e) => ({ description: e.description }))
}
async function hostAgent($: Engine, exposes: boolean) {
  await $.tool.describe({
    tool: 'Agent',
    description: exposes ? `${AGENT_HEAD}\nSet run_in_background: false only when …` : `${AGENT_HEAD}\nNo background.`,
    provider: { plugin: 'engine', tier: 'core' },
  } as never)
}

test(
  'a long foreground pi run with no run_in_background keeps its live row updating',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    hostAgentHooks(on)
    slowPi(on, clock, { everyMs: 5_000, forMs: 60_000 })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await hostAgent($, true)
    const call = $.tool.call({
      tool: 'Agent',
      description: 'Review toolu_a',
      prompt: 'review the repo',
      subagent_type: 'pi:explore',
      tool_use_id: 'toolu_a',
    } as never)
    await clock.settle()
    const ui = await mountRow($, 'toolu_a')
    const seen: string[] = []
    for (const step of [5_000, 25_000, 25_000]) {
      await clock.advance(step)
      seen.push(JSON.stringify(await ui.drawn()))
    }
    expect(seen[0]).toContain('pi:explore')
    expect(seen[0]).toContain('1 tool use')
    expect(seen[0]).toContain('5s')
    expect(seen[1]).toContain('6 tool uses')
    expect(seen[1]).toContain('30s')
    expect(seen[2]).toContain('11 tool uses')
    expect(seen[2]).toContain('55s')
    await ui.unmount()
    await clock.advance(10_000)
    const ran = await call
    expect(ran.deny).toBeUndefined()
    expect((ran.result as { content: { text: string }[] }).content[0]?.text).toBe('slow DONE')
  },
)

test(
  'several parallel foreground pi runs each draw and update their own live row',
  { timeoutMs: 60_000, options: { background: 'never' } },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    hostAgentHooks(on)
    const spawned = slowPi(on, clock, { everyMs: 5_000, forMs: 60_000 })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await hostAgent($, false)
    const ids = ['toolu_p1', 'toolu_p2', 'toolu_p3', 'toolu_p4']
    const calls = ids.map(id =>
      $.tool.call({
        tool: 'Agent',
        description: `Review ${id}`,
        prompt: 'review the repo',
        subagent_type: 'pi:explore',
        tool_use_id: id,
      } as never),
    )
    await clock.settle()
    expect(spawned.length).toBe(4)
    const rows = await Promise.all(ids.map(id => mountRow($, id)))
    await clock.advance(10_000)
    for (const [i, ui] of rows.entries()) {
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain(`Review ${ids[i]}`)
      expect(drawn).toContain('2 tool uses')
      expect(drawn).toContain('10s')
    }
    await clock.advance(20_000)
    for (const ui of rows) {
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('6 tool uses')
      expect(drawn).toContain('30s')
    }
    for (const ui of rows) await ui.unmount()
    await clock.advance(40_000)
    const ran = await Promise.all(calls)
    for (const r of ran) expect(r.deny).toBeUndefined()
  },
)

test(
  'a silent pi (a long model turn) still ticks the elapsed time on its live row',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    silentPi(on, clock, 60_000)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({
      tool: 'Agent',
      description: 'Review toolu_s',
      prompt: 'review the repo',
      subagent_type: 'pi:explore',
      tool_use_id: 'toolu_s',
    } as never)
    await clock.settle()
    const ui = await mountRow($, 'toolu_s')
    await clock.advance(12_000)
    expect(JSON.stringify(await ui.drawn())).toContain('12s')
    await clock.advance(20_000)
    expect(JSON.stringify(await ui.drawn())).toContain('32s')
    await ui.unmount()
    await clock.advance(30_000)
    const ran = await call
    expect((ran.result as { content: { text: string }[] }).content[0]?.text).toBe('thought hard DONE')
  },
)

test(
  'a hung pi is killed by the idle watchdog with an actionable error',
  { timeoutMs: 60_000, options: { idleTimeoutSec: 60 } },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on, { settings: { defaultModel: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }, tiers: {}, profiles: [] } })
    const killed = hungPi(on, { stderr: 'retrying request (1/3)\nretrying request (2/3)\n' })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({
      tool: 'Agent',
      description: 'Hang',
      prompt: 'review the repo',
      subagent_type: 'pi:explore',
      tool_use_id: 'toolu_h',
    } as never)
    await clock.settle()
    await clock.advance(61_000)
    const ran = await call
    expect(ran.deny).toBeDefined()
    expect(ran.deny).toContain('watchdog')
    expect(ran.deny).toContain('openrouter/deepseek/deepseek-v4.1-flash')
    expect(ran.deny).toContain('1m 0s')
    expect(ran.deny).toContain('Last tool step: grep p1 (still running)')
    expect(ran.deny).toContain('retrying request (2/3)')
    expect(ran.deny).not.toContain('The pi subagent was interrupted.')
    await clock.settle()
    expect(killed).toEqual([true])
  },
)

test(
  'a run that keeps going hits the wall-clock cap',
  { timeoutMs: 60_000, options: { maxRunMinutes: 1 } },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    slowPi(on, clock, { everyMs: 10_000, forMs: 600_000 })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({
      tool: 'Agent',
      description: 'Forever',
      prompt: 'review the repo',
      subagent_type: 'pi:explore',
      tool_use_id: 'toolu_w',
    } as never)
    await clock.settle()
    await clock.advance(61_000)
    const ran = await call
    expect(ran.deny).toContain('1m 0s wall-clock cap')
    expect(ran.deny).toContain('maxRunMinutes')
    expect(ran.deny).toContain('pi:explore on pi default')
  },
)

test(
  'with no run_in_background in the host schema, auto runs pi in the background',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    hostAgentHooks(on)
    mock.env(on, { TMPDIR: '/tmp/' })
    const files: Record<string, string> = {}
    on('fs.write', (_, e) => {
      files[e.path] = e.text
      return { value: undefined }
    })
    on('ui.toast', () => ({ value: undefined }))
    const notices: string[] = []
    on('prompt.submit', (_, e) => {
      notices.push(e.text)
      return { text: e.text }
    })
    slowPi(on, clock, { everyMs: 5_000, forMs: 20_000 })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await hostAgent($, false)
    const ids = ['toolu_b1', 'toolu_b2', 'toolu_b3', 'toolu_b4']
    const launched = await Promise.all(
      ids.map(id =>
        $.tool.call({
          tool: 'Agent',
          description: `Review ${id}`,
          prompt: 'review the repo',
          subagent_type: 'pi:explore',
          tool_use_id: id,
        } as never),
      ),
    )
    for (const r of launched) {
      const rec = r.result as { status: string; outputFile: string }
      expect(rec.status).toBe('async_launched')
      expect(rec.outputFile).toMatch(/^\/tmp\/claude-pi\/pi-.+\.md$/)
    }
    await clock.advance(30_000)
    expect(notices.length).toBe(4)
    for (const n of notices) expect(n).toContain('slow DONE')
    for (const r of launched) {
      expect(files[(r.result as { outputFile: string }).outputFile]).toContain('## Final report')
    }
  },
)

test(
  'with run_in_background in the host schema, a call without it stays in the foreground',
  async ($, on) => {
    engine(on)
    mock.store(on)
    hostAgentHooks(on)
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: FIXTURE_LINES.join('\n') + '\n' }
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await hostAgent($, true)
    const ran = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:explore' })
    expect((ran.result as { status: string }).status).toBe('completed')
  },
)
