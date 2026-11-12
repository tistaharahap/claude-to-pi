---
name: creating-pi-agents
description: Use when the user wants to create, design or set up a new pi subagent or agent file on a non-Claude model, a persona agent (reviewer, critic, advisor, specialist), an agent "like" or "modeled on" a real person or a blend of people, or asks for an agent with real taste, character or strong opinions.
---

# Creating pi agents

## Overview

A pi agent is a Claude Code agent file (`.claude/agents/<name>.md` or `~/.claude/agents/<name>.md`) whose `model` is `pi:<provider>/<model>[:thinking]`. The pi plugin runs it on pi. You build one with the user in a brainstorming session, one question at a time.

**What makes the agent succeed is its character, taste and conviction.** A checklist with a tone of voice is not a persona. Spend most of the session there: draw them out of the user, or research them from a real person's record. Never fill them in from your own defaults or someone's reputation.

**You write nothing until the user has seen the full file and said yes.**

## The session

Ask one question per message. Use AskUserQuestion when there are choices, with your recommendation first and marked "(Recommended)". Keep a running draft in your head and play it back when it changes shape.

1. **The job.** What it works on, what it gets as input, and what Claude needs back from it (a verdict, a ranked list, a patch, a plan). Ask for a real example of the input if they have one.
2. **The mode.** Ask with AskUserQuestion:
   - **Easy:** you ask about the job, the persona, the model and whether it may change files. Everything else gets a sensible default, which you list at confirmation.
   - **Advanced:** they also set the knobs in the table below.
3. **The persona source.** Ask with AskUserQuestion: an original character, a real person, or a blend of people. Also offer 2–3 real people known for this kind of work, each with one line on what they would bring. Only suggest people with a substantial public record of their own work in the domain.
   - For a real person or a blend, follow persona-research.md (in this skill's folder) before drafting. That covers public figures, private people (a coworker, an old lead) and blends.
4. **Character, taste, conviction.** See the next section. This is the heart of the session: take as many questions as it needs.
5. **The model.** See Choosing the model.
6. **Name, scope and access.** Pick the name (lowercase, hyphens), project (`.claude/agents/`) or user (`~/.claude/agents/`), and read-only or allowed to edit and run commands. Check the target path: if a file is there, show it and ask before replacing it.
7. **Draft and confirm.** Write the body using agent-template.md (in this skill's folder). Show the complete file and its path in one message. Then ask with AskUserQuestion: "Write it", "Change something" or "Cancel". Write only on "Write it". Every later change gets the same confirmation.
8. **After writing.** Say how to call it (`subagent_type: "<name>"`), that Claude Code may list a new file only after a restart, and offer a trial run on a real input. Ask before running it.

## Character, taste and conviction

Get each one in concrete terms. For an original persona, get them from the user. For a real person, start from the research and confirm with the user.

| Part | Ask for | Done when you have |
|---|---|---|
| **Character** | How it treats people, its temperament, what it cares about beyond the task, how it says no | 3–5 traits, each with how it shows in the output |
| **Taste** | What it loves and hates in this domain: "Show me something it would praise. Now something a generic reviewer would let through but it would reject." | At least 3 good/bad pairs, specific enough to quote, and what it notices first |
| **Conviction** | Beliefs it will defend even when the user disagrees, what it won't compromise on, and what evidence would change its mind | 3–7 specific, arguable beliefs, plus its non-negotiables |

Draw these out with questions like:
- "What would this agent hate that most people tolerate?"
- "When it disagrees with you, what does it do?"
- "Which of these two would it pick, and why?" Give two concrete options from their domain.

Cut any line that would fit any expert ("thorough", "helpful", "high standards"). Turn a bold manner into a stance with reasons: keep the directness, never cruelty, insults or contempt, even when the person modeled was known for them.

## Choosing the model

Never guess a model id; use only ids pi lists.

1. Find what is in use now. `/pi status` shows the plugin's default; pi's own default is `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json`.
2. Ask what matters most with AskUserQuestion: cheap and fast, strongest reasoning, a vendor they prefer, or images (screenshots).
3. Run `pi --list-models <word> --offline` with a word that fits the answer (`flash`, `mini`, `haiku`, `opus`, `gpt`, `gemini`, `qwen`, `deepseek`). The full list has hundreds of entries, so never paste it. The columns are provider, model, context, max-out, thinking and images.
4. Offer up to 4 concrete ids from that output with AskUserQuestion, the current default first if it fits. They can type another id under "Other": check it against the list.
5. In advanced mode, also ask for the thinking level and suggest fallback models (`/pi fallback add <ref>`), which the user runs.

## Knobs

| Knob | Easy default | Advanced |
|---|---|---|
| `model` | Chosen together | Plus thinking (`:high`) or `effort` |
| `tools` | Read-only: `Read, Grep, Glob`; editing: omit `tools` (all of pi's tools) | Exact allowlist or `disallowedTools`; `Bash` is never read-only |
| MCP | None (read-only) / pi's MCP servers (no `tools` list) | Name `mcp__server__tool` entries. Servers come from `pi mcp list`; new ones are added with `pi mcp add` |
| `skills` | None | Skills preloaded from `.claude/skills/<name>/` |
| `description` | You write it: when Claude should delegate | They edit it |
| Output contract | Verdict first, then findings | Their own format |
| `maxTurns`, `background`, `omitClaudeMd` | Unset | Set as they choose |

`mcpServers`, `hooks` and `permissionMode` don't apply on pi; don't offer them.

## Common mistakes

| Mistake | Instead |
|---|---|
| Writing the file as soon as the request is clear, even when told "just write it" | Show the full file, ask, and write only on "Write it". A hurried user gets easy mode and fewer questions, never a skipped confirmation. |
| Picking the model yourself | Offer listed ids and let the user choose |
| A persona built from reputation ("blunt like Linus") | Research the record; model principles and taste, not a manner |
| Searching the web for a private person | Interview the user about them (persona-research.md) |
| Calling an agent with `Bash` read-only | It can change things. Say so, or drop `Bash`. |
| The agent claiming to be the person, or quoting them | It works from their published principles; quotes only from sources you read |
