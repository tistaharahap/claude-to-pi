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
- To compare models, send one call per profile in a single message with identical prompts. For proposals, keep runs propose-only ("return a diff, edit nothing") or use `--read-only` profiles, because parallel `pi:agent` runs share one checkout.

## Common mistakes

| Mistake | Instead |
| --- | --- |
| Putting a model name in the prompt, or `model: "opus"`, to choose a pi model | Use a profile or `/pi model`, and confirm with `resolvedModel` |
| `isolation: "worktree"` | Not supported, and the call is refused. Use propose-only prompts. |
| `SendMessage` to a finished pi agent | Not possible: runs don't persist. Start a new run and paste the earlier report into the prompt. |
| Assuming a background `pi:agent` will wait for approvals | pi never asks. It edits files and runs commands without Claude Code's permission prompts. Say so before dispatching `pi:agent` for edits, and prefer `pi:explore` when nothing should change. |
| Treating a failed run (unknown model, provider 4xx) as Claude's fault | The error names the pi model. Ask the user to fix it with `/pi`. |
