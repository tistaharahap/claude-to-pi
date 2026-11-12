// Claude Code agent files (`.claude/agents/*.md`) that run on pi: an agent
// whose `model` is `pi:<provider>/<model>[:thinking]` is dispatched to pi by
// the bridge. This module parses those files and maps their fields onto pi.
// Nothing here touches `$`, so it is tested directly.

import type { PiModel } from '../types'
import { THINKING_LEVELS, formatModel, parseModelRef } from './pi'

/** The `model` prefix that marks an agent file as a pi agent. */
export const PI_MODEL_PREFIX = 'pi:'

export type FmValue = string | number | boolean | string[] | Record<string, string>

export type Frontmatter = { data: Record<string, FmValue>; body: string }

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1)
    return v.startsWith('"') ? inner.replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n') : inner.replace(/''/g, "'")
  }
  return v
}

/** A scalar with any ` # comment` dropped, unquoted, and typed when it is a boolean or an integer. */
function scalar(raw: string): FmValue {
  let v = raw.trim()
  if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, '')
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  return unquote(v)
}

function inlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1)
  if (inner.trim() === '') return []
  return inner.split(',').map(s => unquote(s)).filter(s => s !== '')
}

/**
 * Parses the YAML frontmatter of an agent file: the subset agent files use
 * (scalars, quoted strings, `[a, b]` and `- item` lists, `|`/`>` blocks, and
 * nested maps kept as flat strings). Undefined when the file has none.
 */
export function parseFrontmatter(text: string): Frontmatter | undefined {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return undefined
  const data: Record<string, FmValue> = {}
  const head = lines.slice(1, end)
  for (let i = 0; i < head.length; i++) {
    const line = head[i] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#') || /^\s/.test(line)) continue
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line)
    if (m === null) continue
    const key = m[1] as string
    const rest = (m[2] ?? '').trim()
    // The indented lines that belong to this key.
    const block: string[] = []
    while (i + 1 < head.length && (/^\s/.test(head[i + 1] ?? '') || (head[i + 1] ?? '').trim() === '')) {
      block.push(head[++i] ?? '')
    }
    while (block.length > 0 && (block[block.length - 1] ?? '').trim() === '') block.pop()
    if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const indent = Math.min(...block.filter(l => l.trim() !== '').map(l => /^\s*/.exec(l)?.[0].length ?? 0))
      const body = block.map(l => l.slice(Number.isFinite(indent) ? indent : 0))
      data[key] = rest.startsWith('|') ? body.join('\n') : body.join(' ').replace(/\s+/g, ' ').trim()
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = inlineList(rest)
    } else if (rest !== '') {
      data[key] = scalar(rest)
    } else if (block.some(l => l.trim().startsWith('- '))) {
      data[key] = block
        .filter(l => l.trim().startsWith('- '))
        .map(l => unquote(l.trim().slice(2)))
        .filter(s => s !== '')
    } else if (block.length > 0) {
      const map: Record<string, string> = {}
      for (const l of block) {
        const kv = /^\s*([^:]+):(.*)$/.exec(l)
        if (kv !== null) map[(kv[1] ?? '').trim()] = unquote(kv[2] ?? '')
      }
      data[key] = map
    } else {
      data[key] = ''
    }
  }
  return { data, body: lines.slice(end + 1).join('\n').trim() }
}

/** A list field as Claude Code reads it: a YAML list, or a comma-separated string. */
export function listOf(v: FmValue | undefined): string[] | undefined {
  if (v === undefined) return undefined
  if (Array.isArray(v)) return v.map(s => s.trim()).filter(s => s !== '')
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(s => s !== '')
  return []
}

/** Whether a `model` value names a pi model (`pi:<provider>/<model>`). */
export function isPiModelRef(model: unknown): model is string {
  return typeof model === 'string' && model.trim().startsWith(PI_MODEL_PREFIX) && model.trim().length > PI_MODEL_PREFIX.length
}

/** Where an agent file lives, in Claude Code's words for agent scopes. */
export type AgentScope = 'project' | 'user'

/** An agent file found on disk, before it is known to be a pi agent. */
export type AgentFile = {
  path: string
  scope: AgentScope
  name: string
  /** The raw `model` value, when the file sets one. */
  model?: string
  text: string
}

/** Reads an agent file's `name` and `model`; undefined when it has no usable name. */
export function agentFileOf(text: string, path: string, scope: AgentScope): AgentFile | undefined {
  const fm = parseFrontmatter(text)
  if (fm === undefined) return undefined
  const name = fm.data.name
  if (typeof name !== 'string' || name.trim() === '' || name.includes(':')) return undefined
  const model = fm.data.model
  return { path, scope, name: name.trim(), ...(typeof model === 'string' ? { model: model.trim() } : {}), text }
}

/** Frontmatter keys an agent file may set that a pi run does not apply. */
const UNAPPLIED_KEYS = ['mcpServers', 'hooks', 'permissionMode', 'memory'] as const

/** A pi agent defined in a Claude Code agent file. */
export type PiAgentDef = {
  name: string
  description: string
  model: PiModel
  path: string
  scope: AgentScope
  /** The file's body: the agent's own instructions. */
  prompt: string
  effort?: string
  tools?: string[]
  disallowedTools?: string[]
  skills: string[]
  omitClaudeMd: boolean
  background: boolean
  maxTurns?: number
  isolation?: string
  /** Keys the file sets that pi does not apply (see UNAPPLIED_KEYS). */
  unapplied: string[]
}

/** Parses an agent file into a pi agent; undefined when it is not one (no `pi:` model). */
export function parsePiAgent(text: string, path: string, scope: AgentScope): PiAgentDef | undefined {
  const fm = parseFrontmatter(text)
  if (fm === undefined) return undefined
  const { data, body } = fm
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (name === '' || name.includes(':') || !isPiModelRef(data.model)) return undefined
  const model = parseModelRef(data.model.trim().slice(PI_MODEL_PREFIX.length))
  if (model === undefined) return undefined
  const effort = typeof data.effort === 'string' ? data.effort.trim() : undefined
  const tools = listOf(data.tools)
  const disallowedTools = listOf(data.disallowedTools)
  const maxTurns = typeof data.maxTurns === 'number' && data.maxTurns > 0 ? data.maxTurns : undefined
  const isolation = typeof data.isolation === 'string' && data.isolation.trim() !== '' ? data.isolation.trim() : undefined
  return {
    name,
    description: typeof data.description === 'string' ? data.description : '',
    model,
    path,
    scope,
    prompt: body,
    ...(effort !== undefined && effort !== '' ? { effort } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    skills: listOf(data.skills) ?? [],
    omitClaudeMd: data.omitClaudeMd === true,
    background: data.background === true,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    unapplied: UNAPPLIED_KEYS.filter(k => data[k] !== undefined && data[k] !== '' && !(Array.isArray(data[k]) && (data[k] as string[]).length === 0)),
  }
}

// ---------------------------------------------------------------------------
// Tools

/** Claude Code tool names and the pi tools that do their job. */
const TOOL_MAP: Record<string, string[]> = {
  Read: ['read'],
  Grep: ['grep'],
  Glob: ['find', 'ls'],
  LS: ['ls'],
  Bash: ['bash'],
  Edit: ['edit'],
  MultiEdit: ['edit'],
  Write: ['write'],
}
const PI_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']
const WRITE_TOOLS = ['bash', 'edit', 'write']
/** pi's tools for calling MCP: codemode scripts and deferred tool search. */
export const MCP_HELPER_TOOLS = ['codemode', 'tool_search']

/** `mcp__server` (every tool of a server) becomes pi's `mcp__server__*`; pi spells `-` in server names as `_`. */
function mcpEntry(name: string): string {
  const parts = name.split('__')
  const server = (parts[1] ?? '').replace(/-/g, '_')
  if (parts.length <= 2 || (parts[2] ?? '') === '') return `mcp__${server}__*`
  return ['mcp', server, ...parts.slice(2)].join('__')
}

export type ToolPlan = {
  /** pi's allowlist (`--tools`); undefined: pi's own defaults; empty: no tools. */
  tools?: string[]
  /** pi's denylist (`--exclude-tools`). */
  exclude?: string[]
  /** Whether pi's MCP servers connect for the run. */
  mcp: boolean
  /** Whether the run can change nothing (no bash, edit, write, MCP). */
  readOnly: boolean
  /** Claude Code tools with no pi equivalent, left out. */
  unmapped: string[]
}

function mapNames(names: readonly string[], unmapped: string[]): { pi: string[]; mcp: string[] } {
  const pi: string[] = []
  const mcp: string[] = []
  for (const raw of names) {
    // `Bash(git *)`: the pattern is a Claude Code permission rule pi can't apply; the tool still maps.
    const name = raw.replace(/\(.*\)\s*$/, '').trim()
    if (name.startsWith('mcp__')) mcp.push(mcpEntry(name))
    else if (TOOL_MAP[name] !== undefined) pi.push(...(TOOL_MAP[name] ?? []))
    else if (PI_TOOLS.includes(name)) pi.push(name)
    else if (name !== '' && !unmapped.includes(name)) unmapped.push(name)
  }
  return { pi: [...new Set(pi)], mcp: [...new Set(mcp)] }
}

/**
 * Maps an agent file's `tools` and `disallowedTools` onto pi. As in Claude
 * Code, a `tools` list allows only what it names: MCP tools only when listed
 * (pi's MCP stays off otherwise); without `tools` the agent gets all of pi's
 * tools, its MCP servers included.
 */
export function mapTools(tools?: readonly string[], disallowed?: readonly string[]): ToolPlan {
  const unmapped: string[] = []
  const allow = tools === undefined ? undefined : mapNames(tools, unmapped)
  const deny = disallowed === undefined ? undefined : mapNames(disallowed, [])
  const exclude = deny === undefined ? [] : [...deny.pi, ...deny.mcp]
  const mcp = allow === undefined ? true : allow.mcp.length > 0
  const allowed =
    allow === undefined ? undefined : [...allow.pi, ...allow.mcp, ...(allow.mcp.length > 0 ? MCP_HELPER_TOOLS : [])]
  const writable = (allowed ?? PI_TOOLS).filter(t => WRITE_TOOLS.includes(t) && !exclude.includes(t))
  return {
    ...(allowed !== undefined ? { tools: allowed } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
    mcp,
    readOnly: writable.length === 0 && !mcp,
    unmapped,
  }
}

/** A Claude effort level as pi's thinking level, when pi has it. */
export function thinkingOf(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined
  const level = effort.trim().toLowerCase()
  return (THINKING_LEVELS as readonly string[]).includes(level) ? level : undefined
}

/** What the bridge tells the orchestrator about fields of an agent file pi did not apply. */
export function agentNotes(opts: { def: PiAgentDef; unmapped: readonly string[]; missingSkills: readonly string[] }): string[] {
  const { def, unmapped, missingSkills } = opts
  const notes: string[] = []
  if (unmapped.length > 0) notes.push(`tools with no pi equivalent were left out: ${unmapped.join(', ')}`)
  if (def.unapplied.includes('mcpServers')) {
    notes.push('mcpServers is not applied: pi agents use the MCP servers configured in pi (add them with `pi mcp add`)')
  }
  const others = def.unapplied.filter(k => k !== 'mcpServers')
  if (others.length > 0) notes.push(`not applied on pi: ${others.join(', ')}`)
  if (missingSkills.length > 0) notes.push(`skills not found: ${missingSkills.join(', ')}`)
  return notes
}

/** The note line a report ends with, for one or more bridge notes. */
export function bridgeNote(notes: readonly string[]): string | undefined {
  return notes.length === 0 ? undefined : `[pi bridge: ${notes.join('; ')}.]`
}

// ---------------------------------------------------------------------------
// Where agent files live, and which one wins

/**
 * The project's agent folders, closest to the working directory first: the
 * `.claude/agents` of the working directory and each parent, short of the
 * home directory (whose `.claude/agents` is the user's).
 */
export function projectAgentDirs(cwd: string, home?: string): string[] {
  return projectDirs(cwd, home).map(d => `${d}/.claude/agents`)
}

/** The working directory and its parents, closest first, short of the home directory. */
export function projectDirs(cwd: string, home?: string): string[] {
  const dirs: string[] = []
  let dir = cwd.replace(/\/+$/, '') || '/'
  const stop = home?.replace(/\/+$/, '')
  for (;;) {
    if (dir !== stop) dirs.push(dir === '/' ? '' : dir)
    if (dir === '/' || dir === '') break
    const up = dir.slice(0, dir.lastIndexOf('/')) || '/'
    if (up === dir) break
    dir = up
  }
  return dirs
}

/**
 * Picks the file Claude Code uses for an agent name. `files` come in
 * precedence order (project folders closest first, then the user's). When the
 * engine said where the agent it lists comes from, only that scope counts: a
 * managed, `--agents` or plugin agent of the same name is not a file here.
 */
export function chooseAgentFile(files: readonly AgentFile[], name: string, source?: string): AgentFile | undefined {
  const named = files.filter(f => f.name === name)
  if (source === undefined) return named[0]
  if (source === 'projectSettings' || source === 'localSettings') return named.find(f => f.scope === 'project')
  if (source === 'userSettings') return named.find(f => f.scope === 'user')
  return undefined
}

// ---------------------------------------------------------------------------
// Writing agent files for `/pi profile`

const PROFILE_PROMPT = [
  'You are a subagent that Claude Code dispatches to work on one task.',
  'Do the task you are given thoroughly, then report what you found and did.',
].join(' ')

function yamlString(v: string): string {
  return /^[\w ./,:()+-]+$/.test(v) && !/^[\s-]/.test(v) && !/:(\s|$)/.test(v) ? v : JSON.stringify(v)
}

/** The agent file `/pi profile add` writes. */
export function renderAgentFile(p: { name: string; model: PiModel; readOnly: boolean; description: string }): string {
  return [
    '---',
    `name: ${p.name}`,
    `description: ${yamlString(p.description)}`,
    `model: ${PI_MODEL_PREFIX}${formatModel(p.model)}`,
    ...(p.readOnly ? ['tools: Read, Grep, Glob'] : []),
    '---',
    '',
    p.readOnly ? `${PROFILE_PROMPT} You are read-only: investigate and report; do not modify files.` : PROFILE_PROMPT,
    '',
  ].join('\n')
}

/** The agent file with its `model` set to a pi model (added after `name` when it has none). */
export function setAgentModel(text: string, model: PiModel): string | undefined {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return undefined
  const line = `model: ${PI_MODEL_PREFIX}${formatModel(model)}`
  const at = lines.findIndex((l, i) => i > 0 && i < end && /^model\s*:/.test(l))
  if (at >= 0) lines[at] = line
  else {
    const nameAt = lines.findIndex((l, i) => i > 0 && i < end && /^name\s*:/.test(l))
    lines.splice(nameAt >= 0 ? nameAt + 1 : end, 0, line)
  }
  return lines.join('\n')
}

/** A skill's SKILL.md without its frontmatter: what an agent's `skills` preloads. */
export function skillBody(text: string): string {
  const fm = parseFrontmatter(text)
  return (fm === undefined ? text : fm.body).trim()
}
