---
name: Cortex - Agent Memory
description: Use throughout any coding session in a project where the cortex-memory plugin is installed. Recall prior project memory before making non-trivial decisions, cite the memories you actually used, and store salient decisions so the next session never re-explains itself. Activates whenever you are about to plan, decide an approach, debug a recurring issue, or end a working session.
version: 0.1.0
---

# Cortex - Agent Memory — the working agreement

You have a sovereign, decay-aware memory for this project, exposed through MCP
tools. Memories that get **cited** survive and grow their lease; memories that
go unused decay for free. Your job is to keep that loop healthy so future
sessions (and future-you) inherit hard-won context instead of relearning it.

At session start, the Cortex recall hook may inject a "Cortex recalls for
<project>:" block. Treat that as a starting point, not the whole picture — pull
more with `cortex_recall` when you need it.

## The loop

1. **Recall before you decide.** Before choosing an approach, debugging
   something that smells familiar, or answering "have we solved this before?",
   call `cortex_recall({ query, k: 5, project })`. Use the current repo's
   project id (the recall hook prints it). Read the returned previews.

2. **Cite what you actually used.** When you act on a recalled memory, call
   `cortex_act({ action, citations: [<entityKey>, ...] })` with the ids from the
   *most recent* `cortex_recall`. Each valid citation fires an accumulative
   lease extension — this is how useful memory survives. Do NOT cite ids you
   did not use; hallucinated/unused citations are dropped and waste nothing, but
   they also teach the engine nothing. When you can tell whether the recalled
   memory actually helped, pass `outcome` (0–1: 1 = it led to a correct result,
   0 = it was wrong/unhelpful) — that makes reinforcement *utility-gated*, so
   genuinely useful memories earn longer leases than merely-often-cited ones.

3. **Store salient decisions.** When you settle an architectural decision,
   resolve a non-obvious bug, or establish a convention, capture it:
   - For a durable, recoverable note (a decision record, a gotcha, a pattern),
     use `cortex_store_document({ text, title, project })`.
   - At the end of a working session, you may write a concise summary with
     `cortex_summarize_session({ summary, sessionId, project })`. (The plugin's
     PreCompact/SessionEnd hooks also auto-capture a deterministic summary, so
     this is for when you want a higher-quality, hand-authored one.)

## What to recall / store

Recall and store the things that are expensive to rediscover:

- **Decisions + rationale** — "we chose X over Y because Z." Always include the
  *because*; a decision without its reason rots.
- **Gotchas** — non-obvious failure modes, footguns, environment quirks.
- **Conventions** — naming, file layout, the project's house style.
- **Cross-cutting context** — how subsystems connect, who owns what.

Do NOT store secrets, credentials, or large blobs. Keep stored text concise and
written *for future retrieval* — lead with the conclusion.

## Guidance

- Prefer one `cortex_recall` early in a task over many scattered ones.
- When you cite, cite precisely — the lease economics depend on honest signal.
- If a tool is unavailable (no wallet/embedding configured), continue working
  normally; memory is additive, never a blocker.
