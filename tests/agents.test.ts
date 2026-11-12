import { expect, test } from 'claude-code/testing'

import {
  agentFileOf,
  agentNotes,
  bridgeNote,
  chooseAgentFile,
  isPiModelRef,
  listOf,
  mapTools,
  parseFrontmatter,
  parsePiAgent,
  projectAgentDirs,
  renderAgentFile,
  setAgentModel,
  skillBody,
  thinkingOf,
} from '../hooks/agents'
import { buildArgv } from '../hooks/pi'

const REVIEWER = [
  '---',
  'name: reviewer',
  'description: "Reviews diffs: correctness only."',
  'model: pi:openai/gpt-5.5:high # the pi model',
  'effort: low',
  'tools: Read, Grep, Glob',
  'skills:',
  '  - review-checklist',
  'maxTurns: 12',
  'color: blue',
  '---',
  '',
  'You are a strict reviewer.',
  '',
].join('\n')

test('frontmatter: scalars, quotes, comments, lists and blocks', async () => {
  const fm = parseFrontmatter(
    [
      '---',
      'name: x',
      "description: 'It''s here'",
      'tools: [Read, "Bash(git *)"]',
      'disallowedTools:',
      '  - Write',
      '  - Edit',
      'background: true',
      'maxTurns: 3',
      'notes: |',
      '  line one',
      '  line two',
      'mcpServers:',
      '  - github',
      'hooks:',
      '  PreToolUse: x',
      '---',
      'Body text.',
    ].join('\n'),
  )
  expect(fm?.data.name).toBe('x')
  expect(fm?.data.description).toBe("It's here")
  expect(fm?.data.tools).toEqual(['Read', 'Bash(git *)'])
  expect(fm?.data.disallowedTools).toEqual(['Write', 'Edit'])
  expect(fm?.data.background).toBe(true)
  expect(fm?.data.maxTurns).toBe(3)
  expect(fm?.data.notes).toBe('line one\nline two')
  expect(fm?.data.mcpServers).toEqual(['github'])
  expect(fm?.data.hooks).toEqual({ PreToolUse: 'x' })
  expect(fm?.body).toBe('Body text.')
  expect(parseFrontmatter('no frontmatter')).toBeUndefined()
  expect(listOf('Read, Grep')).toEqual(['Read', 'Grep'])
})

test('a pi agent file parses; one without a pi model is not a pi agent', async () => {
  const def = parsePiAgent(REVIEWER, '/p/.claude/agents/reviewer.md', 'project')
  expect(def).toMatchObject({
    name: 'reviewer',
    description: 'Reviews diffs: correctness only.',
    model: { provider: 'openai', model: 'gpt-5.5', thinking: 'high' },
    effort: 'low',
    tools: ['Read', 'Grep', 'Glob'],
    skills: ['review-checklist'],
    maxTurns: 12,
    prompt: 'You are a strict reviewer.',
    unapplied: [],
  })
  expect(parsePiAgent(REVIEWER.replace('pi:openai/gpt-5.5:high # the pi model', 'sonnet'), '/x.md', 'user')).toBeUndefined()
  expect(isPiModelRef('pi:')).toBe(false)
  expect(isPiModelRef('pi:openrouter/qwen/qwen3-coder')).toBe(true)
  expect(agentFileOf(REVIEWER, '/x.md', 'user')).toMatchObject({ name: 'reviewer', model: 'pi:openai/gpt-5.5:high' })
  expect(agentFileOf('---\nname: a:b\n---\n', '/x.md', 'user')).toBeUndefined()
})

test('tools map onto pi; a tools list keeps MCP off unless it names MCP tools', async () => {
  expect(mapTools(['Read', 'Grep', 'Glob'])).toEqual({
    tools: ['read', 'grep', 'find', 'ls'],
    mcp: false,
    readOnly: true,
    unmapped: [],
  })
  expect(mapTools(undefined)).toEqual({ mcp: true, readOnly: false, unmapped: [] })
  const withMcp = mapTools(['Read', 'mcp__git-hub__get_issue', 'mcp__linear', 'WebFetch', 'Bash(git *)'])
  expect(withMcp.tools).toEqual(['read', 'bash', 'mcp__git_hub__get_issue', 'mcp__linear__*', 'codemode', 'tool_search'])
  expect(withMcp.mcp).toBe(true)
  expect(withMcp.readOnly).toBe(false)
  expect(withMcp.unmapped).toEqual(['WebFetch'])
  // Only unmapped tools: pi gets none.
  expect(mapTools(['WebSearch']).tools).toEqual([])
  expect(mapTools(['Read', 'Bash'], ['Bash']).readOnly).toBe(true)
  expect(mapTools(undefined, ['Write', 'mcp__github']).exclude).toEqual(['write', 'mcp__github__*'])
})

test('notes say what pi did not apply, including where MCP servers come from', async () => {
  const def = parsePiAgent(
    REVIEWER.replace('color: blue', 'mcpServers:\n  - github\npermissionMode: plan'),
    '/x.md',
    'project',
  )
  expect(def?.unapplied).toEqual(['mcpServers', 'permissionMode'])
  const notes = agentNotes({ def: def!, unmapped: ['WebFetch'], missingSkills: ['nope'] })
  expect(notes).toEqual([
    'tools with no pi equivalent were left out: WebFetch',
    'mcpServers is not applied: pi agents use the MCP servers configured in pi (add them with `pi mcp add`)',
    'not applied on pi: permissionMode',
    'skills not found: nope',
  ])
  expect(bridgeNote([])).toBeUndefined()
  expect(bridgeNote(['a', 'b'])).toBe('[pi bridge: a; b.]')
})

test('agent folders: the working directory up, short of home; the engine’s source picks the scope', async () => {
  expect(projectAgentDirs('/home/u/code/app', '/home/u')).toEqual([
    '/home/u/code/app/.claude/agents',
    '/home/u/code/.claude/agents',
    '/home/.claude/agents',
    '/.claude/agents',
  ])
  const files = [
    { path: '/p/.claude/agents/r.md', scope: 'project' as const, name: 'r', model: 'pi:a/b', text: '' },
    { path: '/h/.claude/agents/r.md', scope: 'user' as const, name: 'r', model: 'sonnet', text: '' },
  ]
  expect(chooseAgentFile(files, 'r')?.scope).toBe('project')
  expect(chooseAgentFile(files, 'r', 'userSettings')?.scope).toBe('user')
  expect(chooseAgentFile(files, 'r', 'projectSettings')?.scope).toBe('project')
  expect(chooseAgentFile(files, 'r', 'flagSettings')).toBeUndefined()
  expect(chooseAgentFile(files, 'nope')).toBeUndefined()
})

test('profile files round-trip, and the picker can change their model', async () => {
  const text = renderAgentFile({
    name: 'fast',
    model: { provider: 'openai', model: 'gpt-5.4-mini', thinking: 'low' },
    readOnly: true,
    description: 'Quick lookups: grep and read. Runs on pi (openai/gpt-5.4-mini:low).',
  })
  const def = parsePiAgent(text, '/x/fast.md', 'user')
  expect(def?.description).toBe('Quick lookups: grep and read. Runs on pi (openai/gpt-5.4-mini:low).')
  expect(def?.model).toEqual({ provider: 'openai', model: 'gpt-5.4-mini', thinking: 'low' })
  expect(mapTools(def?.tools).readOnly).toBe(true)

  const moved = setAgentModel(text, { provider: 'openrouter', model: 'qwen/qwen3-coder' })
  expect(parsePiAgent(moved ?? '', '/x/fast.md', 'user')?.model).toEqual({ provider: 'openrouter', model: 'qwen/qwen3-coder' })
  const added = setAgentModel('---\nname: y\n---\nbody', { provider: 'a', model: 'b' })
  expect(added).toBe('---\nname: y\nmodel: pi:a/b\n---\nbody')
})

test('effort levels pi knows become thinking; skills drop their frontmatter', async () => {
  expect(thinkingOf('HIGH')).toBe('high')
  expect(thinkingOf('9000')).toBeUndefined()
  expect(skillBody('---\nname: s\n---\n\n# Steps\n1. x')).toBe('# Steps\n1. x')
})

test('argv: tools, MCP, trust, context files and the agent prompt', async () => {
  const argv = buildArgv({
    piPath: 'pi',
    plan: {
      agentType: 'reviewer',
      readOnly: true,
      tools: ['read', 'grep'],
      excludeTools: ['write'],
      mcp: false,
      noContextFiles: true,
      prompt: 'You are a strict reviewer.',
    },
    prompt: 'review',
    isolate: true,
  })
  expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep')
  expect(argv[argv.indexOf('--exclude-tools') + 1]).toBe('write')
  expect(argv).toContain('--no-mcp')
  expect(argv).toContain('--approve')
  expect(argv).toContain('--no-context-files')
  expect(argv).not.toContain('builtin:mcp')
  const system = argv[argv.indexOf('--append-system-prompt') + 1] ?? ''
  expect(system).toContain('read-only mode')
  expect(system.endsWith('You are a strict reviewer.')).toBe(true)

  const open = buildArgv({ piPath: 'pi', plan: { agentType: 'x', readOnly: false, mcp: true, tools: [] }, prompt: 'p', isolate: true })
  expect(open).toContain('--no-tools')
  expect(open.join(' ')).toContain('-e builtin:mcp -e builtin:codemode -e builtin:tool-search')
  // Without isolation pi loads its own extensions, MCP among them.
  const loose = buildArgv({ piPath: 'pi', plan: { agentType: 'x', readOnly: false, mcp: true }, prompt: 'p', isolate: false })
  expect(loose).not.toContain('-e')
})
