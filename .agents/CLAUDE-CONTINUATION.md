# Claude → Codex handoff (2026-10-12)

## Verified handoff

- The primary Claude session ID is `5ecb3e99-8eba-4534-b067-ae335593504b`
  (titled `v0`). It ran from July 2026 to September 24, 2026, with other Claude
  agent/worktree sessions preserved in the private archive.
- The last substantive Claude update reported tasks **211** (locale toggle) and
  **212** (rejected-operation labels) merged and marked done, CI green, with
  task **27b** parked on physical hardware and **197** pending its trigger.
  Its final answer to “did you properly merge everything?” failed with an API
  503 on September 24; don't treat that failure as an unmerged commit.
- The same update recorded three corrected, overconfident factual claims
  (root-cause mechanism, op-type registry count, and a duplicated spec rule).
  Verify claims against their actual producers. The accepted i18n decision D28
  keeps labels in each module's ordinary catalog, rather than a special store.
- On October 12 the previously clean checkout was fast-forwarded from `277026a`
  to the existing local `origin/main` tip `0680fe6`. `main` and `origin/main`
  then matched. The index at this tip marks 211 and 212 done. This says nothing
  about a newer remote tip or CI status today: verify when continuing.
- Existing clean worktrees: `.claude/worktrees/task-144-item4-5-chip-a11y-visual`
  at `0680fe6` (`main-sync`), and older `agent-ac198cb95aa33be8e`
  (`task/200-extract-chaos-duplication`) and `agent-af18667fca123ec20`
  (`review-guards`). Inspect status and branch before reusing; do not assume the
  older branches were intended to merge.

## Where the full history lives

- Local, ignored backup: `.codex/claude-migration/bolusi-claude.tar.gz`.
  It contains the **original project-scoped Claude session JSONL trees**, their
  subagent data, the full project `memory/` directory, and the primary session's
  `file-history/` snapshots. This is a backup,
  **not** an import into Codex's own native thread database. Claude's global
  history, other projects, and unrelated plans were not imported. Raw project
  transcripts may still contain secrets; treat the archive as sensitive.
- Original live session:
  `~/.claude/projects/-home-joseph-bolusi/5ecb3e99-8eba-4534-b067-ae335593504b.jsonl`.
  Original memory index:
  `~/.claude/projects/-home-joseph-bolusi/memory/MEMORY.md`.
  Consult the index and only the memory page relevant to the task; reconcile
  historical observations with the current checkout.
- To inspect the local archive, run
  `tar -tzf .codex/claude-migration/bolusi-claude.tar.gz | head`.
  To search readable messages in the live session, run
  `node .agents/scripts/claude-history.mjs --search 'query' --last 20`.
  Pass `--file <path>` for a different JSONL session. The script prints excerpts,
  not all tool payloads; the archive preserves the original bytes.
- The original workflow remains in tracked `CLAUDE.md`,
  `.claude/skills/*/SKILL.md`, and `.claude/review-model.md`; the Codex skill
  entrypoints are `.agents/skills/*/SKILL.md`.

## Next action

No in-flight implementation was left in the primary session. Start by checking
`git status -sb`, `git log -1`, the relevant rows of
`ai-docs/tasks/_index.md`, and CI if needed. Ask for the next feature/bug when
none is specified; do not invent a task from a historical transcript.
