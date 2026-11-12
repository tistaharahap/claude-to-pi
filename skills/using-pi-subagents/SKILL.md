---
name: using-pi-subagents
description: Use when the user asks for pi, for a non-Claude model (GPT, Qwen, DeepSeek, Gemini, OpenRouter models), for a second opinion that isn't Claude, for a cheaper model to do delegated work, or for several models to compare answers, and when deciding between pi:agent, pi:explore or a pi profile and Claude's own subagents.
---

# Using pi subagents

## Overview

`pi:*` agent types run on the pi coding agent, so the work is done by whatever provider/model pi is set to, not by Claude. You call them through the normal Agent tool. Each run is one-shot: pi gets your prompt, works on its own, and its final message comes back as the Agent result.

## When to use which

| Situation | Use |
| --- | --- |
| User asks for pi, or for a non-Claude model | `pi:explore` (read-only) or `pi:agent` (can edit and run commands) |
| User wants a second opinion that isn't Claude | `pi:explore` on that model |
| Read-only research the user wants done cheaply | `pi:explore` |
| The user didn't mention pi or another model | Claude's own tools or agents (`Explore`, `general-purpose`) |
| The task needs Claude Code's MCP servers, skills or permission prompts | Claude's own agents. pi has none of these. |

## Choosing the model

The Agent tool's `model` parameter only accepts Claude aliases, so a pi model can never go there by name. The user picks pi models with `/pi`. You can't run slash commands, so tell the user the exact line to run:

- Default for `pi:agent` and `pi:explore`: `/pi model openai/gpt-5.5`
- A named agent type: `/pi profile add gpt55 openai/gpt-5.5 --read-only`, which creates `pi:gpt55`. Use profiles when you need several models side by side.
- A tier: `/pi tier haiku openai/gpt-5.4-mini`. After that, `model: "haiku"` on a pi type runs that model.
- `/pi status` shows the current mapping. `/pi` opens a picker that lists every model pi can reach.

Model references are `provider/model[:thinking]`, for example `openrouter/qwen/qwen3-coder`. `effort` on the Agent call sets pi's thinking level.

- For a one-off model, suggest a profile rather than `/pi model`, so the user's default stays as it was.
- When you don't know a model's exact id, don't guess. Ask the user to look it up with `/pi models <word>`, for example `/pi models deepseek`.

If `/pi status` already maps what the user asked for, dispatch straight away. Each result's `resolvedModel` (`pi:<provider>/<model>`) tells you what actually ran. Report it to the user and flag any mismatch.

## Writing the call

- Make the prompt self-contained. pi sees none of this conversation, only your prompt and the repo, including its `AGENTS.md`/`CLAUDE.md`.
- `run_in_background: true` returns at once. Progress goes to the `outputFile` in the result, and the final report arrives later as a task notification. Don't poll the file.
- A foreground pi call blocks your turn until pi finishes. When the provider stalls (common on OpenRouter: nothing from the model for 90 s) or fails with a timeout or 5xx, the plugin resumes the run in a fresh pi session on its own, keeping the work done so far, and moves to any `/pi fallback` models on later retries. A report that ends with a `[pi bridge: … attempt failed …]` note recovered this way, and the note names the model it finished on. A run that keeps stalling, has a tool silent for 3 minutes, or runs past 30 minutes fails, and the error names the model, the elapsed time, the attempts, the last tool step and pi's stderr. Read that error before retrying.

## When your Agent tool has no `run_in_background`

Check your Agent tool's parameters. Some sessions (background jobs, setups with background tasks disabled) don't offer `run_in_background`. Two things follow:

- With the plugin's default `background: "auto"`, every pi Agent call in such a session already runs in the background: you get `status: "async_launched"` with an `outputFile`, and the report arrives as a task notification. Don't wait on it or poll the file. Carry on, or end your turn.
- If the user set `background: "never"`, or you need the run outside the Agent tool, and the work is long (whole-repo reviews, several runs in parallel), run pi yourself through Bash with `run_in_background: true` on the Bash call. Use exactly the argv the plugin builds. For `pi:explore` (read-only) that is:

```bash
out="${TMPDIR:-/tmp}/claude-pi/manual-$(date +%s)-$RANDOM"; mkdir -p "$(dirname "$out")"
pi --print --mode json --no-session \
  --model <provider/model> --thinking <level> \
  --tools read,grep,find,ls \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --append-system-prompt "$(printf '%s\n\n%s' \
    'You are running as a subagent dispatched by Claude Code (the orchestrating agent). Work autonomously: there is no human to answer questions mid-task, so make reasonable assumptions and state them. Your final message is the only thing returned to the orchestrator. End with a concise, self-contained report: what you did, what you found, files you changed (with paths), and anything left undone.' \
    'You are in read-only mode: investigate and report; do not attempt to modify files.')" \
  -- "<self-contained prompt>" > "$out.jsonl" 2> "$out.err"
```

- Leave out `--model` (and `--thinking`) to use pi's default. Use the model `/pi status` shows for the agent type the user asked for. Don't guess a model id.
- For `pi:agent` (can edit), drop `--tools …` and the second, read-only sentence of the system prompt. Say first that pi edits without Claude Code's permission prompts.
- Keep the isolation flags (`--no-extensions --no-skills --no-prompt-templates --no-themes`) unless the user turned the plugin's `isolate` option off.
- For parallel runs, start one background Bash call per run in the same message, each with its own `$out`.

When the Bash task finishes, read the final answer from the `agent_end` event:

```bash
jq -r 'select(.type=="agent_end") | [.messages[] | select(.role=="assistant")] | last | .content[] | select(.type=="text") | .text' "$out.jsonl"
```

A manual Bash run gets none of the plugin's stall recovery or watchdogs, so give the Bash call a timeout. If that prints nothing, check for a provider error: `jq -r 'select(.type=="message_end" and .message.role=="assistant") | .message | select(.stopReason=="error") | .errorMessage' "$out.jsonl"`, then `tail -5 "$out.err"`.
- To compare models, send one call per profile in a single message with identical prompts. For proposals, keep runs propose-only ("return a diff, edit nothing") or use `--read-only` profiles, because parallel `pi:agent` runs share one checkout.

## Common mistakes

| Mistake | Instead |
| --- | --- |
| Putting a model name in the prompt, or `model: "opus"`, to choose a pi model | Use a profile or `/pi model`, and confirm with `resolvedModel` |
| `isolation: "worktree"` | Not supported, and the call is refused. Use propose-only prompts. |
| `SendMessage` to a finished pi agent | Not possible: runs don't persist. Start a new run and paste the earlier report into the prompt. |
| Assuming a background `pi:agent` will wait for approvals | pi never asks. It edits files and runs commands without Claude Code's permission prompts. Say so before dispatching `pi:agent` for edits, and prefer `pi:explore` when nothing should change. |
| Treating a failed run (unknown model, provider 4xx) as Claude's fault | The error names the pi model. Ask the user to fix it with `/pi`. |
| Retrying straight after "interrupted by the user (Esc)" | The user stopped it. Ask before running it again, and offer a background run. |
| Retrying a watchdog kill unchanged | The bridge already resumed stalled runs (and tried any `/pi fallback` models) before it gave up. Split the task, or ask the user to pick another model or add fallbacks with `/pi fallback add <provider/model>`. |
| Firing several long foreground pi calls at once when your Agent tool lacks `run_in_background` | Let `background: "auto"` launch them in the background, or use background Bash runs as above. |
