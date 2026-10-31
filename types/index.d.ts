/** A pi model reference: provider, model id and an optional thinking level. */
export type PiModel = {
  provider: string
  model: string
  thinking?: string
}

/** A named pi agent type the person defined with `/pi profile add`. */
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
  profiles: PiProfile[]
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
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted'
  steps: PiStep[]
  toolCount: number
  tokens: number
  cost: number
  tail: string
  error?: string
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
    }
  }
}
