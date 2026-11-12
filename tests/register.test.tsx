import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FIXTURE_LINES } from './fixture'

// Stands for the engine beneath the plugin: registrations succeed.
function engine(on: On) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('agent.register', (_, e) => ({ value: { agent: `pi:${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('ui.status', () => ({ value: undefined }))
  return mock.clock(on, { now: 1_000 })
}

/** A file system in memory: `files` maps absolute paths to their text. */
function fakeFs(on: On, files: Record<string, string> = {}) {
  const childrenOf = (dir: string) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) continue
      const [head, ...tail] = path.slice(dir.length + 1).split('/')
      if (head !== undefined) names.set(head, tail.length > 0 ? 'dir' : 'file')
    }
    return names
  }
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as never
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files[e.path] !== undefined || childrenOf(e.path).size > 0 }))
  on('fs.list', (_, e) => {
    const names = childrenOf(e.path)
    if (names.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
    } as never
  })
  return files
}

/** A fake pi that prints the fixture run; `argvs` collects each run's argv. */
function fakePi(on: On, lines: readonly string[] = FIXTURE_LINES) {
  const argvs: string[][] = []
  on('process.spawn', async function* (_, e) {
    argvs.push([...e.argv])
    yield { stream: 'stdout' as const, text: lines.join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  return argvs
}

const argOf = (argv: readonly string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)

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
  fakeFs(on)
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
  expect(added.text).toContain('Wrote .claude/agents/qwen.md: the subagent type qwen runs on pi (openrouter/qwen/qwen3-coder), read-only.')

  const status = await pi('status')
  expect(status.text).toContain('pi:agent, pi:explore → openai/gpt-5.5:high')
  expect(status.text).toContain('Agent model "haiku" → openai/gpt-5.4-mini')
  expect(status.text).toContain('qwen → openrouter/qwen/qwen3-coder (read-only) · .claude/agents/qwen.md')

  const listed = await pi('profile list')
  expect(listed.text).toBe('qwen → openrouter/qwen/qwen3-coder (read-only) · .claude/agents/qwen.md')
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

// ------------------------------------------------ stalled providers

const sessionHeader = (id: string) => JSON.stringify({ type: 'session', version: 3, id, cwd: '/' })
const userMessage = JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })

type Script =
  | { kind: 'stall'; tool?: boolean }
  | { kind: 'answer'; text: string }
  | { kind: 'error'; message: string }

/**
 * A pi whose attempts follow `script`, one entry per spawn: `stall` writes its
 * session and a tool step, then goes silent until killed; `answer` finishes;
 * `error` ends on a provider error. Each attempt's session id is `s<n>`.
 */
function scriptedPi(on: On, script: Script[]) {
  const spawned: string[][] = []
  const killed: number[] = []
  on('process.spawn', async function* (_, e, next) {
    const n = spawned.length
    spawned.push([...e.argv])
    const step = script[Math.min(n, script.length - 1)] ?? { kind: 'answer', text: 'DONE' }
    yield { stream: 'stdout' as const, text: `${sessionHeader(`s${n + 1}`)}\n${userMessage}\n` }
    if (step.kind === 'stall') {
      yield { stream: 'stdout' as const, text: `${toolStart(n + 1)}\n${step.tool === true ? '' : `${toolEnd(n + 1)}\n`}` }
      try {
        await new Promise<void>(resolve => {
          if (next.signal.aborted) resolve()
          next.signal.addEventListener('abort', () => resolve())
        })
      } finally {
        killed.push(n + 1)
      }
      return { value: { code: null, signal: 'SIGTERM' } }
    }
    if (step.kind === 'error') {
      yield {
        stream: 'stdout' as const,
        text: `${JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: step.message, usage: {} },
        })}\n`,
      }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout' as const, text: `${finalAnswer(step.text)}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { spawned, killed }
}

const argAfter = (argv: readonly string[] | undefined, flag: string) =>
  argv === undefined || !argv.includes(flag) ? undefined : argv[argv.indexOf(flag) + 1]

test(
  'a stalled provider is dropped and the run resumes by forking its pi session',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on, { settings: { defaultModel: { provider: 'openrouter', model: 'qwen/qwen3-coder' }, tiers: {}, profiles: [] } })
    mock.env(on, { TMPDIR: '/tmp/' })
    const removed: string[][] = []
    on('process.run', (_, e) => {
      removed.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    const pi = scriptedPi(on, [{ kind: 'stall' }, { kind: 'answer', text: 'resumed DONE' }])

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({
      tool: 'Agent',
      description: 'Review toolu_r',
      prompt: 'review the repo',
      subagent_type: 'pi:explore',
      tool_use_id: 'toolu_r',
    } as never)
    await clock.settle()
    const ui = await mountRow($, 'toolu_r')
    await clock.advance(60_000)
    expect(pi.spawned.length).toBe(1)
    await clock.advance(31_000)
    await clock.settle()
    expect(pi.killed).toEqual([1])
    expect(pi.spawned.length).toBe(2)
    const ran = await call
    expect(ran.deny).toBeUndefined()

    const [first, second] = pi.spawned
    const dir = argAfter(first, '--session-dir')
    expect(dir).toMatch(/^\/tmp\/claude-pi\/sessions\/pi-[\w-]+$/)
    expect(first).not.toContain('--no-session')
    expect(argAfter(first, '--session-id')).toBeDefined()
    expect(first?.at(-1)).toBe('review the repo')
    expect(argAfter(second, '--session-dir')).toBe(dir)
    expect(argAfter(second, '--fork')).toBe('s1')
    expect(argAfter(second, '--model')).toBe('openrouter/qwen/qwen3-coder')
    expect(second?.at(-1)).toContain('Continue the task from where it stopped')

    const text = (ran.result as { content: { text: string }[] }).content[0]?.text ?? ''
    expect(text).toContain('resumed DONE')
    expect(text).toContain('attempt 1 on openrouter/qwen/qwen3-coder: stalled (no events for 1m 30s')
    expect(removed).toEqual([['rm', '-rf', dir ?? '']])
    await ui.unmount()
  },
)

test(
  'the live row says the provider stalled while the retry runs',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    const pi = scriptedPi(on, [{ kind: 'stall' }, { kind: 'stall' }, { kind: 'answer', text: 'x' }])

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({
      tool: 'Agent',
      description: 'Review toolu_n',
      prompt: 'review the repo',
      subagent_type: 'pi:explore',
      tool_use_id: 'toolu_n',
    } as never)
    await clock.settle()
    const ui = await mountRow($, 'toolu_n')
    await clock.advance(92_000)
    expect(JSON.stringify(await ui.drawn())).toContain('provider stalled · retry 1/2')
    // The second attempt gets twice the stall limit.
    await clock.advance(170_000)
    expect(pi.spawned.length).toBe(2)
    await clock.advance(12_000)
    await clock.settle()
    expect(pi.spawned.length).toBe(3)
    expect(argAfter(pi.spawned[2], '--fork')).toBe('s2')
    await ui.unmount()
    expect((await call).deny).toBeUndefined()
  },
)

test(
  'later retries move to the fallback models',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on, {
      settings: {
        defaultModel: { provider: 'openrouter', model: 'qwen/qwen3-coder', thinking: 'high' },
        tiers: {},
        profiles: [],
        fallbacks: [{ provider: 'openai', model: 'gpt-5.4-mini' }],
      },
    })
    const pi = scriptedPi(on, [{ kind: 'stall' }, { kind: 'stall' }, { kind: 'answer', text: 'fallback DONE' }])

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:agent' })
    await clock.settle()
    await clock.advance(91_000 + 181_000 + 5_000)
    const ran = await call
    expect(ran.deny).toBeUndefined()
    expect(pi.spawned.map(a => argAfter(a, '--model'))).toEqual([
      'openrouter/qwen/qwen3-coder',
      'openrouter/qwen/qwen3-coder',
      'openai/gpt-5.4-mini',
    ])
    expect(argAfter(pi.spawned[2], '--thinking')).toBe('high')
    expect((ran.result as { content: { text: string }[] }).content[0]?.text).toContain('finished on openrouter/deepseek/deepseek-v4.1-flash')
  },
)

test(
  'a provider that keeps stalling fails after the retries, with the history and how to resume',
  { timeoutMs: 60_000, options: { stallRetries: 1, stallTimeoutSec: 30 } },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on, { settings: { defaultModel: { provider: 'openrouter', model: 'qwen/qwen3-coder' }, tiers: {}, profiles: [] } })
    mock.env(on, { TMPDIR: '/tmp/' })
    const removed: string[][] = []
    on('process.run', (_, e) => {
      removed.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    const pi = scriptedPi(on, [{ kind: 'stall' }])

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:agent' })
    await clock.settle()
    await clock.advance(31_000 + 61_000)
    const ran = await call
    await clock.settle()
    expect(pi.spawned.length).toBe(2)
    expect(pi.killed).toEqual([1, 2])
    expect(ran.deny).toContain('on attempt 2 of 2')
    expect(ran.deny).toContain('the model sent nothing for 1m 0s')
    expect(ran.deny).toContain('attempt 1 on openrouter/qwen/qwen3-coder: stalled')
    expect(ran.deny).toContain('--fork s2')
    expect(ran.deny).toContain('/pi fallback add')
    // The failed run's sessions are kept for the person to resume.
    expect(removed).toEqual([])
  },
)

test(
  'stallRetries 0 fails on the first stall',
  { timeoutMs: 60_000, options: { stallRetries: 0 } },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    const pi = scriptedPi(on, [{ kind: 'stall' }])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:agent' })
    await clock.settle()
    await clock.advance(91_000)
    const ran = await call
    expect(pi.spawned.length).toBe(1)
    expect(ran.deny).toContain('stall limit')
    expect(ran.deny).not.toContain('attempt 1 of')
  },
)

test(
  'a transient provider error is retried; a permanent one is not',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    const pi = scriptedPi(on, [
      { kind: 'error', message: '502 Provider returned error' },
      { kind: 'answer', text: 'after 502 DONE' },
      { kind: 'error', message: '401 Unauthorized' },
    ])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ok = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:agent' })
    expect(ok.deny).toBeUndefined()
    expect(pi.spawned.length).toBe(2)
    expect(argAfter(pi.spawned[1], '--fork')).toBe('s1')
    const text = (ok.result as { content: { text: string }[] }).content[0]?.text ?? ''
    expect(text).toContain('after 502 DONE')
    expect(text).toContain('provider error: 502 Provider returned error')

    const bad = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:agent' })
    expect(pi.spawned.length).toBe(3)
    expect(bad.deny).toContain('401 Unauthorized')
    expect(bad.deny).toContain('pi auth check')
    await clock.settle()
  },
)

test(
  'a long silent tool is not a stall: only the idle limit applies to it',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
    const spawned: string[][] = []
    on('process.spawn', async function* (_, e) {
      spawned.push([...e.argv])
      yield { stream: 'stdout' as const, text: `${sessionHeader('s1')}\n${userMessage}\n${toolStart(1)}\n` }
      await clock.sleep(150_000)
      yield { stream: 'stdout' as const, text: `${toolEnd(1)}\n${finalAnswer('built DONE')}\n` }
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:agent' })
    await clock.settle()
    await clock.advance(151_000)
    const ran = await call
    expect(spawned.length).toBe(1)
    expect((ran.result as { content: { text: string }[] }).content[0]?.text).toBe('built DONE')
  },
)

test(
  'a background run that recovers from a stall says so in its notification',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const clock = engine(on)
    mock.store(on)
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
    scriptedPi(on, [{ kind: 'stall' }, { kind: 'answer', text: 'bg DONE' }])

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ran = await $.tool.call({
      tool: 'Agent',
      description: 'x',
      prompt: 'x',
      subagent_type: 'pi:agent',
      run_in_background: true,
    } as never)
    const out = (ran.result as { outputFile: string }).outputFile
    await clock.settle()
    await clock.advance(95_000)
    await clock.settle()
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('bg DONE')
    expect(notices[0]).toContain('stalled')
    expect(files[out]).toContain('## Retries')
  },
)

// ------------------------------------------------------------ agent files

const REVIEWER_FILE = [
  '---',
  'name: reviewer',
  'description: Reviews diffs for correctness bugs.',
  'model: pi:openai/gpt-5.5',
  'effort: high',
  'tools: Read, Grep, WebFetch',
  'skills: [checklist]',
  'mcpServers:',
  '  - github',
  '---',
  'You are a strict reviewer.',
].join('\n')

test('an agent file with a pi model runs on pi under its own name', async ($, on) => {
  engine(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  fakeFs(on, {
    '/proj/.claude/agents/review/reviewer.md': REVIEWER_FILE,
    '/home/u/.claude/skills/checklist/SKILL.md': '---\nname: checklist\n---\n1. Check the null paths.',
  })
  const argvs = fakePi(on)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Agent', description: 'Review', prompt: 'review the diff', subagent_type: 'reviewer' })

  expect(ran.deny).toBeUndefined()
  const record = ran.result as { agentType: string; resolvedModel: string; content: { text: string }[] }
  expect(record.agentType).toBe('reviewer')
  expect(record.resolvedModel).toBe('pi:openai/gpt-4.1-mini')
  const text = record.content[0]?.text ?? ''
  expect(text).toContain('Found 2 files. DONE')
  expect(text).toContain('tools with no pi equivalent were left out: WebFetch')
  expect(text).toContain('add them with `pi mcp add`')

  const argv = argvs[0] ?? []
  expect(argOf(argv, '--model')).toBe('openai/gpt-5.5')
  expect(argOf(argv, '--thinking')).toBe('high')
  expect(argOf(argv, '--tools')).toBe('read,grep')
  expect(argv).toContain('--no-mcp')
  expect(argv).toContain('--approve')
  const system = argOf(argv, '--append-system-prompt') ?? ''
  expect(system).toContain('You are a strict reviewer.')
  expect(system).toContain('# Skill: checklist')
  expect(system).toContain('1. Check the null paths.')
})

test('an agent file without tools gets pi’s MCP servers; the call’s effort wins', async ($, on) => {
  engine(on)
  mock.store(on)
  fakeFs(on, { '/proj/.claude/agents/doer.md': '---\nname: doer\ndescription: Does.\nmodel: pi:openrouter/qwen/qwen3-coder:low\n---\nDo it.' })
  const argvs = fakePi(on)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Agent', description: 'Do', prompt: 'do', subagent_type: 'doer', effort: 'max' } as never)
  expect(ran.deny).toBeUndefined()
  const argv = argvs[0] ?? []
  expect(argOf(argv, '--model')).toBe('openrouter/qwen/qwen3-coder')
  expect(argOf(argv, '--thinking')).toBe('max')
  expect(argv).not.toContain('--tools')
  expect(argv).not.toContain('--no-mcp')
  expect(argv.join(' ')).toContain('-e builtin:mcp')
})

test('agent files on Claude models and unknown names go to Claude Code', async ($, on) => {
  engine(on)
  mock.store(on)
  fakeFs(on, { '/proj/.claude/agents/c.md': '---\nname: claudey\ndescription: x\nmodel: sonnet\n---\nHi' })
  const argvs = fakePi(on)
  on('tool.call', () => ({ result: 'claude ran it' }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'claudey' })).result).toBe('claude ran it')
  expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'nobody' })).result).toBe('claude ran it')
  expect(argvs).toHaveLength(0)
})

test('a pi agent started outside the Agent tool is refused; others spawn', async ($, on) => {
  engine(on)
  mock.store(on)
  fakeFs(on, { '/proj/.claude/agents/reviewer.md': REVIEWER_FILE })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }) as never)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  // The kit fills the spawn's pinned fields (provider, parentModel, ...).
  const spawn = (subagentType: string) => $.agent.spawn({ subagentType, prompt: 'x' } as never)
  const refused = await spawn('reviewer')
  expect(refused.deny).toContain('only the Agent tool can start a pi agent')
  const builtin = await spawn('pi:agent')
  expect(builtin.deny).toContain('runs on pi')
  const other = await spawn('Explore')
  expect(other.deny).toBeUndefined()
})

test('an agent file asking for worktree isolation is refused with the file named', async ($, on) => {
  engine(on)
  mock.store(on)
  fakeFs(on, { '/proj/.claude/agents/w.md': '---\nname: w\ndescription: x\nmodel: pi:a/b\nisolation: worktree\n---\n' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'w' })
  expect(ran.deny).toContain('does not support isolation "worktree" (set in /proj/.claude/agents/w.md)')
})

test('maxTurns stops the run and keeps the answer so far', async ($, on) => {
  engine(on)
  mock.store(on)
  fakeFs(on, { '/proj/.claude/agents/brief.md': '---\nname: brief\ndescription: x\nmodel: pi:openai/gpt-4.1-mini\nmaxTurns: 1\n---\n' })
  const turn = (text: string) => [
    JSON.stringify({ type: 'turn_start' }),
    JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'openai', model: 'gpt-4.1-mini', usage: {}, stopReason: 'stop' },
    }),
  ]
  fakePi(on, [...turn('first'), ...turn('second'), ...turn('third')])

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'brief' })
  expect(ran.deny).toBeUndefined()
  const text = (ran.result as { content: { text: string }[] }).content[0]?.text ?? ''
  expect(text).toContain('first')
  expect(text).not.toContain('second')
  expect(text).toContain("stopped at the agent's maxTurns (1)")
})

test('/pi profile add --user writes to ~/.claude/agents; rm removes only pi agent files', async ($, on) => {
  engine(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  const files = fakeFs(on, { '/proj/.claude/agents/mine.md': '---\nname: mine\ndescription: x\nmodel: opus\n---\n' })
  on('process.run', (_, e) => {
    const path = e.argv[e.argv.length - 1] ?? ''
    delete files[path]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  const pi = (args: string) =>
    $.command.run({ command: 'pi', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const added = await pi('profile add fast openai/gpt-5.4-mini:low --user Quick lookups')
  expect(added.text).toContain('Wrote ~/.claude/agents/fast.md')
  expect(files['/home/u/.claude/agents/fast.md']).toContain('model: pi:openai/gpt-5.4-mini:low')
  expect(files['/home/u/.claude/agents/fast.md']).toContain('description: Quick lookups. Runs on pi (openai/gpt-5.4-mini:low).')

  expect((await pi('profile add fast openai/gpt-5.5 --user')).text).toContain('already exists')
  expect((await pi('profile rm mine')).text).toContain('is not a pi agent')
  expect(files['/proj/.claude/agents/mine.md']).toBeDefined()
  expect((await pi('profile rm fast')).text).toContain('Removed ~/.claude/agents/fast.md')
  expect(files['/home/u/.claude/agents/fast.md']).toBeUndefined()
})

test('stored profiles move to ~/.claude/agents once, and pi:<name> still reaches them', async ($, on) => {
  engine(on)
  mock.store(on, {
    settings: {
      tiers: {},
      profiles: [{ name: 'qwen', model: { provider: 'openrouter', model: 'qwen/qwen3-coder' }, readOnly: true }],
    },
  })
  mock.env(on, { HOME: '/home/u' })
  const files = fakeFs(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const argvs = fakePi(on)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(files['/home/u/.claude/agents/qwen.md']).toContain('model: pi:openrouter/qwen/qwen3-coder')
  expect(toasts[0]).toContain('moved qwen to ~/.claude/agents/')

  const ran = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'pi:qwen' })
  expect(ran.deny).toBeUndefined()
  expect((ran.result as { agentType: string }).agentType).toBe('qwen')
  expect(argOf(argvs[0] ?? [], '--tools')).toBe('read,grep,find,ls')
})
