// A trimmed recording of `pi --print --mode json` listing a directory.
const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
})

const assistant = (content: unknown[], u: ReturnType<typeof usage>) => ({
  role: 'assistant',
  content,
  api: 'openai-responses',
  provider: 'openai',
  model: 'gpt-4.1-mini',
  usage: u,
  stopReason: content.some(b => (b as { type: string }).type === 'toolCall') ? 'toolUse' : 'stop',
})

export const FIXTURE_EVENTS: unknown[] = [
  { type: 'session', version: 3, id: 'x', cwd: '/tmp' },
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'list src' }] } },
  {
    type: 'message_end',
    message: assistant([{ type: 'toolCall', id: 'c1', name: 'ls', arguments: { path: 'src' } }], usage(100, 10)),
  },
  { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'ls', args: { path: 'src' } },
  {
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'ls',
    result: { content: [{ type: 'text', text: 'a.ts\nb.ts' }] },
    isError: false,
  },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Found 2 files.' } },
  {
    type: 'message_end',
    message: assistant([{ type: 'text', text: 'Found 2 files. DONE' }], usage(50, 20)),
  },
  { type: 'agent_end', messages: [] },
  { type: 'agent_settled', aborted: false },
]

export const FIXTURE_LINES: string[] = FIXTURE_EVENTS.map(e => JSON.stringify(e))
