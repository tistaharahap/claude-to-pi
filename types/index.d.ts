/** A pi model reference: provider, model id and an optional thinking level. */
export type PiModel = {
  provider: string
  model: string
  thinking?: string
}

/**
 * A pi agent type from before agent files: kept only so profiles stored by an
 * earlier version can be moved to `~/.claude/agents/<name>.md`.
 */
export type PiProfile = {
  name: string
  model: PiModel
  readOnly: boolean
  description?: string
}

/** What the plugin keeps across sessions (in `$.store`) and mirrors in state. */
export type PiSettings = {
  /** The model `pi:agent` and `pi:explore` use; unset means pi's own default. */
  defaultModel?: PiModel
  /** Claude's Agent `model` aliases mapped onto pi models. */
  tiers: Partial<Record<'haiku' | 'sonnet' | 'opus' | 'fable', PiModel>>
  /** Profiles stored by an earlier version; moved to agent files at session start. */
  profiles: PiProfile[]
  /**
   * Models a stalled or failing run moves to, in order, from its second retry
   * on (the first retry keeps the model). Empty or unset: no fallback.
   */
  fallbacks?: PiModel[]
}

/** One tool call a pi run made, as the live row shows it. */
export type PiStep = {
  tool: string
  summary: string
  isDone: boolean
  isError: boolean
}

/** The live view of one pi subagent run, keyed by the Agent call's tool_use_id. */
export type PiRun = {
  agentType: string
  description: string
  model: string
  startedAt: number
  endedAt?: number
  /** When the bridge last redrew the row (at least every second while running). */
  updatedAt?: number
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted'
  steps: PiStep[]
  toolCount: number
  tokens: number
  cost: number
  tail: string
  error?: string
  /** Set while the run recovers from a stall, e.g. "stalled · retry 1/2". */
  notice?: string
}

/** A pi agent from a Claude Code agent file (`model: pi:…`), as `/pi` lists it. */
export type PiAgentSummary = {
  name: string
  model: PiModel
  scope: 'project' | 'user'
  path: string
  readOnly: boolean
  /** Fields pi does not apply, and other things worth knowing about the file. */
  warnings: string[]
}

/** A row of `pi --list-models`. */
export type PiModelRow = {
  provider: string
  model: string
  context: string
  thinking: boolean
}

/** The model picker pane's own state. */
export type PiPicker = {
  filter: string
  thinking: string
  target: string
  models: PiModelRow[]
  isLoading: boolean
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    pi: {
      settings: Shaped<PiSettings>
      runs: Shaped<Record<string, PiRun>>
      picker: Shaped<PiPicker>
      host: Shaped<{ agentExposesBackground?: boolean }>
      agents: Shaped<{ list: PiAgentSummary[] }>
      offers: Shaped<Record<string, string>>
    }
  }
}
