# Bolusi

Offline-first software for a phone-repair franchise in West Papua, Indonesia.
Read `README.md` for orientation and `docs/development.md` for commands.
Read `docs/product-direction.md` for the whole product and milestones, and
`docs/product-scope.md` for current repair-release decisions. Earlier detailed
ideas live in `docs/product-reference/`; read only the relevant sections.
Before any UI or copy work, read `docs/design-guide.md` and meet it.

- When asked to implement a new product scope, first discuss it with the owner.
  Use prior ideas as context, challenge assumptions, and ask focused questions
  about the real workflow, scope, exceptions, permissions, offline behavior and
  acceptance. Recommend simpler alternatives. Old PRD “Must” labels are not fresh
  approval. Record the resulting agreement briefly, then proceed with authorized
  implementation. Do not repeat settled questions or interview for routine fixes.
- Implement the requested outcome in small, reviewable changes. Reuse existing
  code before adding abstractions. Do not invent preventative infrastructure work.
- Inspect the branch and local changes before editing; preserve other work.
  Concurrent threads need separate branches/worktrees. Coordinate shared migrations.
- Code, migrations, and executed tests establish what exists. Project memory
  supplies context, not proof that work landed or verification passed.
- Add regression tests for bugs and meaningful tests for new behavior. Run checks
  appropriate to the change; report actual results and anything not verified.
- A UI task is done only after interactive QA: run the real app, use the changed
  flow, look at screenshots, and report on the PR. Follow `docs/qa.md`.
- Preserve tenant isolation, authorization, operation integrity, offline recovery,
  and money/stock correctness. Test changes to these directly.
- Keep secrets out of source and reports. Ask before deployment, destructive data
  changes, or external actions not already authorized by the user.
- Update a short document when an enduring decision or setup step changes.
  Routine work needs no task number, phase skill, status ledger, review-agent quota,
  security identifier, or documentation-parsing test.

Claude Code Projects manages priorities, threads, and working memory. Repository
instructions stay here so every clone has the same basic development guidance.
