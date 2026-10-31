# Claude to Pi

A Claude Code plugin that runs subagents on [pi](https://github.com/badlogic/pi-mono), the multi-provider coding agent, so Claude can hand work to OpenAI, OpenRouter, or any other provider/model pi supports. It works through the normal `Agent` tool: pi subagents show up in Claude's agent list, run with a live progress row in the transcript, and return through the standard subagent hand-back.

## Install

```
/plugin install pi --marketplace tistaharahap/claude-to-pi
```

or from a shell: `claude plugin install pi --marketplace tistaharahap/claude-to-pi`.

For development, load it from a checkout: `claude --plugin-dir /path/to/claude-to-pi`.

Requirements: `pi` on your `PATH` (or set the plugin's `piPath` option), with at least one provider signed in (`pi auth check --provider <name>`).

## Using it

Ask for it the way you would ask for any subagent:

> Use a pi agent to find every place we parse dates and summarize the formats.

Claude picks one of these agent types:

| Agent type | What it does |
| --- | --- |
| `pi:agent` | General-purpose: reads, runs commands, edits files (pi's full tool set). |
| `pi:explore` | Read-only: `read`, `grep`, `find`, `ls`. |
| `pi:<profile>` | Your own types, each bound to a model (see `/pi profile`). |

The `Agent` tool's own parameters still apply:

- `model: "haiku" | "sonnet" | "opus" | "fable"` picks the pi model you mapped to that tier with `/pi tier`. Unmapped tiers use the default.
- `effort: "low" … "max"` sets pi's `--thinking` level.
- `run_in_background: true` returns right away. Progress streams to an output file Claude can read, and the final report comes back as a task notification when pi finishes. Some sessions' Agent tool has no `run_in_background`; see the `background` option below.

## Options

Set these in the plugin's settings (`claude plugin configure pi`):

| Option | Default | What it does |
| --- | --- | --- |
| `piPath` | `pi` | The pi executable. |
| `isolate` | `true` | Run pi with `--no-extensions --no-skills --no-prompt-templates --no-themes`. |
| `background` | `auto` | `auto`: run in the background when the call sets `run_in_background: true`, or when this session's Agent tool has no `run_in_background` parameter; otherwise run in the foreground. `always`: every pi run is a background task. `never`: every pi run is in the foreground. |
| `idleTimeoutSec` | `180` | Kill a run that sends no pi JSON event for this many seconds. |
| `maxRunMinutes` | `30` | Kill a run that is still going after this many minutes. |

**The `background` trade-off.** A foreground run hands its report straight back in the same turn, but it blocks that turn until pi finishes, and several parallel foreground runs block it until the slowest one ends. A background run frees the turn right away, but the report arrives later as a task notification, so Claude has to wait for it or carry on without it. In sessions where the Agent tool has no `run_in_background` parameter (some background jobs, or background tasks disabled), Claude can't ask for a background run. `auto` then assumes the run may be long and backgrounds it rather than silently blocking. The plugin reads this from the Agent tool's description, the only part of its schema a plugin can see. Use `never` if you'd rather keep results inline and watch the live rows, or `always` if every pi run should be a background task.

The plugin also ships a skill, `using-pi-subagents`, that teaches Claude when to send work to pi and how to do it. It covers choosing a model with `/pi` (Claude can't pick a pi model through the Agent call), confirming the model that actually ran via `resolvedModel`, comparing several models side by side, and what pi agents don't support.

## Choosing providers and models

| Command | Effect |
| --- | --- |
| `/pi` | Opens the model picker: filter pi's model list, choose a thinking level, and set the default, a tier, or a profile. |
| `/pi status` | Shows which models the pi agent types use. |
| `/pi model openai/gpt-5.5:high` | Sets the default for `pi:agent` and `pi:explore` (`/pi model reset` goes back to pi's own default). |
| `/pi openrouter/qwen/qwen3-coder` | Shorthand for `/pi model …`. |
| `/pi tier haiku openai/gpt-5.4-mini` | Calls with `model: "haiku"` on pi types run that model. |
| `/pi profile add fast openai/gpt-5.4-mini:low --read-only Quick lookups` | Adds the agent type `pi:fast`. |
| `/pi profile rm fast` / `/pi profile list` | Removes or lists profiles. |

Model references use `provider/model[:thinking]`, the same format as `pi --model`. Settings persist across sessions. The status line shows the current default (`π openai/gpt-5.5`).

## How it works

The plugin is a Claude Code hooks module (`hooks/register.tsx`). The pure logic (argv, the event stream, the background decision, watchdogs, error messages) lives in `hooks/pi.ts`.

1. **Agent types.** `$.agent.register` declares `pi:agent`, `pi:explore` and your profiles, so they appear in Claude's agent listing like built-in agent types.
2. **Dispatch.** A `tool.call` hook on `Agent` handles every `pi:*` call. It decides foreground or background (the `background` option), then runs `pi --print --mode json --no-session …` through `$.process.spawn` and folds pi's JSON event stream into a run tally (tool calls, tokens, cost, the final message).
3. **Result.** A foreground run returns a real `Agent` `completed` record (`resolvedModel: "pi:<provider>/<model>"`, token usage, tool stats), so Claude Code treats the report like any other subagent's. A background run returns `async_launched` with an `outputFile` at once, writes progress to that file every few seconds, and submits a `<task-notification>` with the final report (or the error) when pi ends.
4. **Live row.** A `ui.render` hook on the `Agent` tool row draws pi's tool calls, tokens, cost and elapsed time while a foreground run is in progress. The row redraws at least once a second even when pi prints nothing (a long model turn with no tool calls), so the elapsed time keeps ticking. Once the run finishes, the native row takes over.
5. **Watchdogs.** On the same one-second beat the bridge checks two limits: no pi JSON event for `idleTimeoutSec` (default 180 s), and a wall-clock cap of `maxRunMinutes` (default 30 min). When either expires, the bridge kills pi and returns an error with the model, the elapsed time, the partial tally, the last tool step and the last 5 lines of pi's stderr. A stuck run never just hangs.
6. **Errors.** The error says which way the run ended: interrupted by the user (Esc), stopped by a watchdog (idle or wall-clock), a provider/model error from pi (unknown model, 4xx, rate limits), a bad pi exit, or pi not starting at all. Each comes with a hint on what to do next.
7. **Esc** interrupts a foreground run and kills the pi process.

By default pi runs isolated (`--no-extensions --no-skills --no-prompt-templates --no-themes`) so packages you use in interactive pi don't hijack subagent runs. pi still reads `AGENTS.md`/`CLAUDE.md`. Turn this off with the `isolate` option.

## Caveats

- pi runs its own tools, so **Claude Code's permission prompts don't apply inside a pi subagent**. Use `pi:explore` or a `--read-only` profile when you want a run that can't change anything. This matters more for background runs, which nobody watches.
- A foreground pi call blocks Claude's turn until pi finishes, and parallel foreground calls block it until the slowest one ends. The live rows keep ticking, but for long work prefer background runs.
- With `background: "auto"`, a session whose Agent tool lacks `run_in_background` runs **every** pi call in the background, short ones included. That costs an extra round trip for a quick lookup. Set `background: "never"` to opt out.
- The watchdogs can kill a legitimately slow run, for example a model thinking silently for more than 3 minutes. Raise `idleTimeoutSec` or `maxRunMinutes` for such models.
- Background runs aren't tied to Esc. Only the watchdogs (or the session ending) stop them.
- `isolation: "worktree"` and `SendMessage` follow-ups aren't supported for pi agents.
- `pi --list-models` only lists providers pi can see. Sign in with pi first.

## Development

```
claude plugin validate .
claude plugin test .
```

Tests live in `tests/`. `tests/pi.test.ts` covers the pure logic: stream, argv, options, the background decision, watchdogs and failure messages. `tests/register.test.tsx` drives the hooks against the engine's test kit, with fake `pi` processes behind `process.spawn` on a mocked clock: slow, silent, hung and parallel runs.
