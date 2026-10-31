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
- `run_in_background: true` returns right away. Progress streams to an output file Claude can read, and the final report comes back as a task notification when pi finishes.

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

The plugin is a Claude Code hooks module (`hooks/register.tsx`):

1. **Agent types.** `$.agent.register` declares `pi:agent`, `pi:explore` and your profiles, so they appear in Claude's agent listing like built-in agent types.
2. **Dispatch.** A `tool.call` hook on `Agent` handles every `pi:*` call. It runs `pi --print --mode json --no-session …` through `$.process.spawn` and folds pi's JSON event stream into a run tally (tool calls, tokens, cost, the final message).
3. **Result.** The hook returns a real `Agent` `completed` record (`resolvedModel: "pi:<provider>/<model>"`, token usage, tool stats), so Claude Code treats the report like any other subagent's. Errors such as an unknown model or a provider 4xx come back as tool errors.
4. **Live row.** A `ui.render` hook on the `Agent` tool row draws pi's tool calls, tokens, cost and elapsed time while the run is in progress. Once it finishes, the native row takes over.
5. **Esc** interrupts the run and kills the pi process.

By default pi runs isolated (`--no-extensions --no-skills --no-prompt-templates --no-themes`) so packages you use in interactive pi don't hijack subagent runs. pi still reads `AGENTS.md`/`CLAUDE.md`. Turn this off with the `isolate` option.

## Caveats

- pi runs its own tools, so **Claude Code's permission prompts don't apply inside a pi subagent**. Use `pi:explore` or a `--read-only` profile when you want a run that can't change anything.
- `isolation: "worktree"` and `SendMessage` follow-ups aren't supported for pi agents.
- `pi --list-models` only lists providers pi can see. Sign in with pi first.

## Development

```
claude plugin validate .
claude plugin test .
```

Tests live in `tests/`. `tests/pi.test.ts` covers the pure stream/argv logic. `tests/register.test.tsx` drives the hooks against the engine's test kit, with a fake `pi` behind `process.spawn`.
