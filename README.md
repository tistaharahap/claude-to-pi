# Claude to Pi

A Claude Code plugin that runs subagents on [pi](https://github.com/badlogic/pi-mono), the multi-provider coding agent, so Claude can hand work to OpenAI, OpenRouter, or any other provider/model pi supports. It works through the normal `Agent` tool: pi subagents show up in Claude's agent list, run with a live progress row in the transcript, and return through the standard subagent hand-back.

Any Claude Code agent file can run on pi: give it a pi model.

```markdown
# .claude/agents/reviewer.md
---
name: reviewer
description: Reviews diffs for correctness bugs. Use after any non-trivial change.
model: pi:openai/gpt-5.5
effort: high
tools: Read, Grep, Glob
---
You are a strict code reviewer…
```

## Install

```
/plugin install pi --marketplace tistaharahap/claude-to-pi
```

or from a shell: `claude plugin install pi --marketplace tistaharahap/claude-to-pi`.

For development, load it from a checkout: `claude --plugin-dir /path/to/claude-to-pi`.

Requirements: `pi` on your `PATH` (or set the plugin's `piPath` option), with at least one provider signed in (`pi auth check --provider <name>`). Tested with pi 1.5.

## Using it

Ask for it the way you would ask for any subagent:

> Use a pi agent to find every place we parse dates and summarize the formats.

Claude picks one of these agent types:

| Agent type | What it does |
| --- | --- |
| `pi:agent` | General-purpose: reads, runs commands, edits files (pi's full tool set, and pi's MCP servers). |
| `pi:explore` | Read-only: `read`, `grep`, `find`, `ls`. |
| `<name>` | Any agent file whose `model` is `pi:<provider>/<model>[:thinking]` (see below). |

The `Agent` tool's own parameters still apply:

- `model: "haiku" | "sonnet" | "opus" | "fable"` picks the pi model you mapped to that tier with `/pi tier`. Unmapped tiers use the default.
- `effort: "low" … "max"` sets pi's `--thinking` level.
- `run_in_background: true` returns right away. Progress streams to an output file Claude can read, and the final report comes back as a task notification when pi finishes. Some sessions' Agent tool has no `run_in_background`; see the `background` option below.

## Agent files on pi

Claude Code reads agent files from `.claude/agents/` in the project (and its parent folders) and from `~/.claude/agents/`. Set an agent's `model` to `pi:` followed by a pi model reference and it runs on pi. Claude Code lists it under its own name with its own description, and Claude calls it like any other agent: `Agent({ subagent_type: "reviewer", … })`. Everything else about the file works the way Claude Code reads it, as far as pi can do it:

| Field | On pi |
| --- | --- |
| body | Appended to pi's own system prompt, after a short subagent brief. |
| `model: pi:<provider>/<model>[:thinking]` | `--model` (and `--thinking`). The Agent call's `model` alias doesn't change it. |
| `effort` | pi's thinking level, unless the model reference sets one. The Agent call's `effort` wins over both. |
| `tools` | pi's allowlist: `Read`→`read`, `Grep`→`grep`, `Glob`→`find`+`ls`, `LS`→`ls`, `Bash`→`bash`, `Edit`/`MultiEdit`→`edit`, `Write`→`write`, `mcp__server__tool` (or `mcp__server` for all of a server's tools) → pi's MCP tool of that name. Tools with no pi equivalent (`WebFetch`, `WebSearch`, …) are left out, and the report says which. Without `tools`, the agent gets all of pi's tools. |
| `disallowedTools` | pi's denylist, mapped the same way. |
| `skills` | Each skill's `SKILL.md` (from `.claude/skills/<name>/` in the project or in `~/.claude`) is preloaded into the agent's prompt. |
| `omitClaudeMd: true` | `--no-context-files`: pi skips `AGENTS.md`/`CLAUDE.md`. |
| `background: true` | The run goes to the background, as if the call set `run_in_background: true` (the plugin's `background: "never"` still keeps it in the foreground). |
| `maxTurns` | The run stops before turn `maxTurns + 1` and returns what it has, marked as possibly partial. |
| `isolation: worktree` | Refused, as for the Agent call. |
| `mcpServers`, `hooks`, `permissionMode`, `memory` | Not applied. The report ends with a note that says so. |
| `color`, `initialPrompt`, `autoCompactWindow` | Ignored. |

**MCP servers.** A pi agent uses the MCP servers configured in pi itself, not Claude Code's. Add the servers your agents need to pi with `pi mcp add <name> …` (`pi mcp list` shows them). Which of them an agent can call follows Claude Code's rule for `tools`: without a `tools` list the agent gets all of them; with one, only the MCP tools it names (and none, with pi's MCP turned off, when it names none). `pi:agent` gets them all; `pi:explore` none.

**Trust.** Claude Code only runs in a folder you trusted (under `claude -p`, trust is implied), so pi runs with `--approve` and trusts the project's own `.pi/` files too.

**Without the plugin.** An agent file with a `pi:` model still loads, but when the plugin isn't there to catch the call, Claude Code sends the model name to the Claude API and the run fails with `model_not_found`. It never quietly runs on Claude.

**Only through the Agent tool.** A pi agent started any other way (a workflow script's `agent()`, a teammate, another plugin's spawn) is refused with a message that says to use the Agent tool. `claude --agent <name>` (a pi agent as the main session) is not supported and fails as above.

To design one with Claude, ask for it ("make me a pi agent that reviews migrations like …"). The `creating-pi-agents` skill runs it as a brainstorming session: the job, then easy or advanced mode, then the persona's character, taste and conviction, and a model picked from what pi lists. It can model the agent on a real person or a blend of people, researching a public figure's published work and interviewing you about a private one. It shows you the full file and writes nothing until you say so. `/pi profile add` writes a minimal file for you (next section). `/pi status` and `/pi profile list` list the pi agent files and warn about fields pi won't apply. Profiles from earlier versions of the plugin are moved to `~/.claude/agents/<name>.md` the first time a session starts, and calls to `pi:<name>` still reach them.

## Options

Set these in the plugin's settings (`claude plugin configure pi`):

| Option | Default | What it does |
| --- | --- | --- |
| `piPath` | `pi` | The pi executable. |
| `isolate` | `true` | Run pi with `--no-extensions --no-skills --no-prompt-templates --no-themes`. |
| `background` | `auto` | `auto`: run in the background when the call sets `run_in_background: true`, or when this session's Agent tool has no `run_in_background` parameter; otherwise run in the foreground. `always`: every pi run is a background task. `never`: every pi run is in the foreground. |
| `stallTimeoutSec` | `90` | A run that gets nothing from the model for this many seconds while pi waits on it counts as stalled: pi is stopped and the run resumes in a fresh pi session. Doubles on each retry. |
| `stallRetries` | `2` | How many times a stalled run (or one that hit a transient provider error: timeout, dropped stream, 429, 5xx) is resumed before it fails. Each `/pi fallback` model gets one retry of its own. `0` turns retrying off. |
| `idleTimeoutSec` | `180` | Kill a run whose pi tool (a long build, a test suite) prints nothing for this many seconds. |
| `maxRunMinutes` | `30` | Kill a run that is still going after this many minutes, retries included. |

**The `background` trade-off.** A foreground run hands its report straight back in the same turn, but it blocks that turn until pi finishes, and several parallel foreground runs block it until the slowest one ends. A background run frees the turn right away, but the report arrives later as a task notification, so Claude has to wait for it or carry on without it. In sessions where the Agent tool has no `run_in_background` parameter (some background jobs, or background tasks disabled), Claude can't ask for a background run. `auto` then assumes the run may be long and backgrounds it rather than silently blocking. The plugin reads this from the Agent tool's description, the only part of its schema a plugin can see. Use `never` if you'd rather keep results inline and watch the live rows, or `always` if every pi run should be a background task.

The plugin also ships two skills. `creating-pi-agents` designs new pi agent files with you (see [Agent files on pi](#agent-files-on-pi)). `using-pi-subagents` teaches Claude when to send work to pi and how to do it. It covers choosing a model with `/pi` (Claude can't pick a pi model through the Agent call), confirming the model that actually ran via `resolvedModel`, comparing several models side by side, and what pi agents don't support.

## Choosing providers and models

| Command | Effect |
| --- | --- |
| `/pi` | Opens the model picker: filter pi's model list, choose a thinking level, and set the default, a tier, or an agent file's model. |
| `/pi status` | Shows which models the pi agent types and pi agent files use. |
| `/pi model openai/gpt-5.5:high` | Sets the default for `pi:agent` and `pi:explore` (`/pi model reset` goes back to pi's own default). |
| `/pi openrouter/qwen/qwen3-coder` | Shorthand for `/pi model …`. |
| `/pi tier haiku openai/gpt-5.4-mini` | Calls with `model: "haiku"` on `pi:agent`/`pi:explore` run that model. |
| `/pi profile add fast openai/gpt-5.4-mini:low --read-only Quick lookups` | Writes `.claude/agents/fast.md` with `model: pi:openai/gpt-5.4-mini:low` (and `tools: Read, Grep, Glob` for `--read-only`). Add `--user` to write `~/.claude/agents/fast.md` instead. Claude Code may list a new file only after a restart. |
| `/pi profile rm fast [--user]` / `/pi profile list` | Removes a pi agent file (never one on a Claude model), or lists them. |
| `/pi fallback add openai/gpt-5.4-mini` | Adds a fallback model for stalled runs (`rm <ref>`, `clear`, `list`). |

Model references use `provider/model[:thinking]`, the same format as `pi --model`. Settings persist across sessions. The status line shows the current default (`π openai/gpt-5.5`).

## Stalled providers (OpenRouter)

OpenRouter forwards each request to one of several upstream providers, and now and then that provider accepts the request and then sends nothing for minutes. The plugin recovers from this on its own:

1. **It tells a stall from slow work.** While pi waits on the model, silence past `stallTimeoutSec` (90 s) means the provider has stalled. While one of pi's tools runs, silence is normal, and only `idleTimeoutSec` (180 s) applies.
2. **It resumes, it doesn't restart.** Every run keeps a pi session in a temporary folder. On a stall, the bridge stops pi and runs `pi --fork <session>` with a short "continue where you stopped" prompt. The new run keeps everything the model and its tools had already done. The forked session also has a new session id, so OpenRouter routes it from scratch (pi pins an OpenRouter session to one upstream for caching), which usually means a different upstream provider.
3. **It backs off.** Each retry doubles the stall limit (90 s, 180 s, 360 s), so a model that legitimately thinks in silence for a long time still gets through.
4. **It can switch models.** The first retry keeps the model. Later retries move through the models you added with `/pi fallback add <ref>`, keeping the run's thinking level unless the fallback sets its own.
5. **Transient errors count too.** Timeouts, dropped streams, 429s and 5xx errors that pi itself gave up on are retried the same way. Errors such as an unknown model, a 401 or a bad request are not.

The live row shows `⟳ provider stalled · retry 1/2` while a retry runs. The final report ends with a one-line note listing the failed attempts and the model the run finished on, so Claude (and you) can see it happened. If every retry fails, the error lists each attempt and keeps the pi session, with the command to inspect or continue it by hand. Successful runs delete their session folder.

To make stalls rarer in the first place, tell OpenRouter how to pick upstream providers. pi passes `openRouterRouting` through as OpenRouter's [provider routing preferences](https://openrouter.ai/docs/guides/routing/provider-selection). In `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "compat": { "openRouterRouting": { "sort": "throughput" } }
    }
  }
}
```

`"sort": "latency"` favours quick first tokens. `"ignore": ["SomeProvider"]` skips an upstream that keeps stalling for you. The setting also applies when you use pi directly, not only to subagents.

## How it works

The plugin is a Claude Code hooks module (`hooks/register.tsx`). The pure logic (argv, the event stream, the background decision, watchdogs, error messages) lives in `hooks/pi.ts`.

1. **Agent types.** `$.agent.register` declares `pi:agent` and `pi:explore`, so they appear in Claude's agent listing like built-in agent types. Agent files are Claude Code's own: it lists them itself.
2. **Dispatch.** A `tool.call` hook on `Agent` handles every `pi:*` call and every call whose agent file has a `pi:` model. It finds that file the way Claude Code does (the project's folders closest first, then `~/.claude/agents/`, with `agent.offer` telling it which scope the listed agent came from), maps its fields onto pi's flags, and decides foreground or background (the `background` option). It then runs `pi --print --mode json --session-dir <temp> …` through `$.process.spawn` and folds pi's JSON event stream into a run tally (tool calls, tokens, cost, the final message). An `agent.spawn` hook refuses pi agents started any other way.
3. **Result.** A foreground run returns a real `Agent` `completed` record (`resolvedModel: "pi:<provider>/<model>"`, token usage, tool stats), so Claude Code treats the report like any other subagent's. A background run returns `async_launched` with an `outputFile` at once, writes progress to that file every few seconds, and submits a `<task-notification>` with the final report (or the error) when pi ends.
4. **Live row.** A `ui.render` hook on the `Agent` tool row draws pi's tool calls, tokens, cost and elapsed time while a foreground run is in progress. The row redraws at least once a second even when pi prints nothing (a long model turn with no tool calls), so the elapsed time keeps ticking. Once the run finishes, the native row takes over.
5. **Watchdogs.** On the same one-second beat the bridge checks three limits: no pi JSON event while pi waits on the model for `stallTimeoutSec` (default 90 s), no event while a pi tool runs for `idleTimeoutSec` (default 180 s), and a wall-clock cap of `maxRunMinutes` (default 30 min). A stall, or a transient provider error, is retried by forking the run's pi session (see [Stalled providers](#stalled-providers-openrouter)). Anything else, or a stall that outlasts the retries, kills pi and returns an error with the model, the elapsed time, the partial tally, the last tool step, the earlier attempts and the last 5 lines of pi's stderr. A stuck run never just hangs.
6. **Errors.** The error says which way the run ended: interrupted by the user (Esc), stopped by a watchdog (stall, idle or wall-clock), a provider/model error from pi (unknown model, 4xx, rate limits), a bad pi exit, or pi not starting at all. Each comes with a hint on what to do next.
7. **Esc** interrupts a foreground run and kills the pi process.

By default pi runs isolated (`--no-extensions --no-skills --no-prompt-templates --no-themes`) so packages you use in interactive pi don't hijack subagent runs. pi's built-in MCP support is loaded back by name (`-e builtin:mcp -e builtin:codemode -e builtin:tool-search`) for runs that may use MCP, and turned off with `--no-mcp` for the rest. pi still reads `AGENTS.md`/`CLAUDE.md` unless the agent file sets `omitClaudeMd`. Turn isolation off with the `isolate` option.

## Caveats

- pi runs its own tools, so **Claude Code's permission prompts don't apply inside a pi subagent**, and an agent file's `permissionMode` and `hooks` are not applied. Use `pi:explore`, or an agent file whose `tools` are read-only (`Read, Grep, Glob`), when you want a run that can't change anything. This matters more for background runs, which nobody watches, and for agent files that come with a repository you cloned.
- A foreground pi call blocks Claude's turn until pi finishes, and parallel foreground calls block it until the slowest one ends. The live rows keep ticking, but for long work prefer background runs.
- With `background: "auto"`, a session whose Agent tool lacks `run_in_background` runs **every** pi call in the background, short ones included. That costs an extra round trip for a quick lookup. Set `background: "never"` to opt out.
- The stall watchdog can stop a model that legitimately thinks in silence for more than 90 s. The run is resumed rather than lost, and each retry waits twice as long, but the silent thinking is redone. Raise `stallTimeoutSec` for such models.
- A resumed run starts a new pi session, so the provider's prompt cache starts cold and the retry re-reads the conversation so far. A tool call that was cut off has no result in the session; pi tells the model, which checks its effect before running it again.
- Background runs aren't tied to Esc. Only the watchdogs (or the session ending) stop them.
- `isolation: "worktree"` and `SendMessage` follow-ups aren't supported for pi agents.
- An agent file's `mcpServers` isn't applied: pi agents use pi's own MCP servers (`pi mcp add`).
- A pi agent file only runs through the Agent tool: workflows, teammates and `claude --agent` can't run it on pi.
- `pi --list-models` only lists providers pi can see. Sign in with pi first.

## Development

```
claude plugin validate .
claude plugin test .
```

Tests live in `tests/`. `tests/pi.test.ts` covers the pure logic: stream, argv, options, the background decision, watchdogs and failure messages. `tests/agents.test.ts` covers agent files: frontmatter, the field and tool mapping, which file wins, and the files `/pi profile` writes. `tests/register.test.tsx` drives the hooks against the engine's test kit, with fake `pi` processes behind `process.spawn` on a mocked clock (slow, silent, hung, stalled-then-resumed, failing-over and parallel runs) and agent files in an in-memory file system.
