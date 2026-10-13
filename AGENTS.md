# Bolusi — Codex project instructions

This project was developed in Claude Code. The source repository, `ai-docs/`, and
`ai-docs/tasks/_index.md` are the authority; transcripts and memories are historical
context, not proof that work landed. For background and the original doc router,
read `CLAUDE.md` §§2–6 as needed. Its §0 Claude-specific invocation syntax maps to
the Codex skills under `.agents/skills/`. Its §1 "bootstrapping" placeholder is
historical: the implemented stack is specified in `ai-docs/08-stack-and-repo.md`.

## Workflow

- Pick the relevant Codex skill before a phase: `brainstorm-prd` → `author-ai-docs`
  → `decompose-tasks` → `implement-task` → `review-wave` → `qa-sweep`. Use only the
  phases the requested change actually needs; each skill retains its original
  Claude instructions and documents Codex-specific substitutions.
- For any task, consult `ai-docs/tasks/_index.md` for status, then its task file
  and only the applicable rows of the doc router in `CLAUDE.md` §3. Update status
  via `pnpm task:status <id> <status>`, not by editing the index manually.
- Read `ai-docs/testing-guide.md` for tests and `ai-docs/security-guide.md` for
  security surfaces. Prove guards can fail before trusting them. Capture the
  command's own exit status alongside its output; don't infer success from a
  background poller or a tool summary.
- Before implementation, check the branch and working directory. Implementation
  agents work in separate worktrees; never edit this main checkout through an
  absolute path from a worktree. Serialize shared packages and DB migrations.
  Before any merge, obtain an independent review and verify actual gates. Don't
  bypass hooks, invent device evidence, or push/deploy without the appropriate
  authorization. Only file new QA tasks for reproducible failures (`CLAUDE.md` §2.7).
- The legacy skills refer to Claude's `Workflow` tool. In Codex, use available
  parallel-agent tools **only when permitted by the current user/developer/tool
  instructions**; otherwise perform the work locally and do not claim an
  independent review took place. Never bypass the review gate by pretending a
  solo pass is a separate reviewer.
- A machine-specific memory note may be stale. Recheck it against current code,
  CI, and `git` before acting; never treat a previous assistant's report as proof.

## Continuation

Read `.agents/CLAUDE-CONTINUATION.md` to resume the September 2026 session.
The private, searchable transcript/memory archive is described there. Do not
commit or paste raw transcripts into public issues: they can contain credentials.
