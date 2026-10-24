# Bolusi

Offline-first software for a phone-repair franchise in West Papua, Indonesia.
Staff use shared, low-end phones with unreliable connectivity. Android and iOS
are supported targets; the interface uses Bahasa Indonesia and English.

The repository implements the platform, authentication, and a Notes reference
module. Repair, inventory, purchasing, and payment workflows are the next product
work, not completed features.

## Start here

- [Development](docs/development.md): install, run, test, and troubleshoot.
- [Architecture](docs/architecture.md): implementation map and important limits.
- [Product scope](docs/product-scope.md): accepted repair-first requirements and
  open choices, preserved from the owner's October decisions.
- [Claude Code Projects](docs/claude-projects.md): migration and project instructions.

## Repository map

| Location                                                                   | Purpose                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/mobile`                                                              | Expo / React Native app and native adapters                              |
| `apps/server`                                                              | Hono server, identity, sync, media, push                                 |
| `packages/core`                                                            | Commands, permissions, signed operations, sync, projections              |
| `packages/modules`                                                         | Module registration; currently Notes plus core auth/platform             |
| `packages/db-client`, `packages/db-server`                                 | SQLite and PostgreSQL persistence/migrations                             |
| `packages/schemas`, `packages/i18n`, `packages/ui`                         | Wire schemas, translations, UI                                           |
| `packages/test-support`, `packages/harness`, `packages/sqlite-test-driver` | Fixtures, integration/chaos tests, Node substitute for the native driver |
| `tooling`, `scripts`                                                       | Build/lint configuration and development utilities                       |

Use Claude Code Projects for planning, research, coordination, and working memory.
Keep code, checks, and durable product decisions in Git. Prefer a usable repair
workflow over more framework or workflow machinery.

The old `ai-docs/` specifications, task ledger, phase skills, and review playbooks
were retired during the Projects migration. Git at `06b063b` retains them.
References to numbered documents/tasks in older source comments are historical
rationale, not active instructions. For example:

```sh
git show 06b063b:ai-docs/05-operation-log.md
```

Consult old documents only for a specific question; their requirements may be
stale. Current owner decisions and implementation take precedence.
