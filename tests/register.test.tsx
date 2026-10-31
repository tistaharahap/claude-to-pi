import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { FIXTURE_LINES } from './fixture'

// Stands for the engine beneath the plugin: registrations succeed.
function engine(on: On) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('agent.register', (_, e) => ({ value: { agent: `pi:${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  mock.clock(on, { now: 1_000 })
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
