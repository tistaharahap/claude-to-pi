# Modeling a persona on real people

An agent modeled on a person carries their **principles, taste and way of reasoning** as documented in their own work. It is never the person: it doesn't claim to be them, speak as them, or put words in their mouth.

## First: what kind of person

| The person | How you learn about them |
|---|---|
| A public figure with published work in the domain (books, essays, talks, code review threads, interviews) | Research their record (below) |
| A private person (a coworker, an old lead, a friend) | Interview the user. Don't search the web for them: a search finds strangers with the same name and digs into someone who didn't sign up for it. |
| Someone famous mostly for their manner, with little published reasoning in this domain | Say so, and suggest someone with a real record, or an original character |

## Researching a public figure

Use the web tools you have (WebSearch and WebFetch, or a research MCP server). If you have none, say so: work from what you know well, mark the brief as unverified, and ask the user for links.

1. **Collect primary sources:** their own words, not articles about them. Aim for at least 5, spread across their career: essays, books, talks, mailing-list or code-review posts, design docs, interviews. Note each URL and date. When one won't load (a PDF you can't parse, a paywall), look for another form of it before moving on: the author's own site, a transcript, a web archive copy. If you still read fewer than 5 in full, say how many in the brief.
2. **Read for substance:** what they argue for and against, the examples they use, the questions they ask of others' work, and what they changed their mind about (and when).
3. **Separate the record from the reputation.** Write down the popular image ("brutal", "genius", "perfectionist") and test it against the sources. Keep what the sources show; drop the caricature. When someone has publicly changed their conduct (an apology, a new code of conduct), model who they are now.
4. **Mark uncertainty.** Every claim in the brief is "documented" (with its source) or "inferred" (with your reasoning). Never invent a quote. Quote only what you read, and keep quotes short.

## Interviewing about a private person

Ask for stories, not adjectives:
- "Tell me about a time they stopped something you were about to ship. What did they say?"
- "What did they always check first?"
- "What did they praise, rarely?"
- "What would they say about [a concrete example from the user's work]?"

Model their standards and judgment, not their identity. Use a role in the file ("a migration reviewer in the style of a former tech lead"), not their full name, unless the user insists and the person would be comfortable with it.

## The persona brief

Before drafting the agent, show the user a brief and ask them to correct it:

```
Persona brief: <name or blend>
Character: 3–5 traits, each with evidence
Taste: what they love / reject, with concrete examples from the sources
Convictions: 3–7 positions, each marked documented (source) or inferred
Changed their mind about: …
Left out on purpose: traits not carried over (e.g. personal attacks) and why
Sources: title, URL, date (one line each)
```

## Blends

For each dimension (character, taste, each conviction), say whose it is. Where the people disagree, ask the user which side wins, and write the winner into the agent with the reason. An agent that holds both sides of a disagreement has no conviction.

## In the agent file

- Open with what the agent draws on: "You review the way <name>'s published writing on <topic> describes: …". It must not say "You are <name>".
- Put each conviction as the agent's own rule, with its reason.
- End the body with an HTML comment listing the sources (`<!-- Sources: … -->`), so anyone editing the file can check them.
