# Florida Roleplay Manager

Cross-guild Discord role synchronization and permissions for a FiveM roleplay community
that runs one main community server plus a separate Discord server per department.

Roles in the approved guilds are kept in agreement with each other according to explicit,
auditable configuration: role mappings and time-bounded manual grants. Everything else in
a member's role list is left strictly alone.

---

## What it does

- **Approved guild allowlist.** A Discord server that is not registered cannot use the bot
  for anything. The bot leaves unapproved servers automatically and alerts administrators.
  Auto-leave can be paused with `/guild autoleave enabled:false` to onboard a new server,
  then switched back on.
- **Cross-guild role mappings.** One-way and two-way, with a configurable authority side,
  separate add/removal switches, priorities, and rejection of anything that would create a
  synchronization loop.
- **Manual role grants.** Time-bounded, audited, and automatically taken back when they
  are revoked or expire — nobody has to remember.
- **Self-service role delegation.** `/rolemanager` lets a member who holds a configured
  role hand out (and take back) a set of other roles, several at a time from a menu, without
  any bot or admin permission. An admin edits the "which role can give out which" mapping
  with `/rolemanager config`, and anyone can see it with `/rolemanager view`.
- **Discord-role access tiers.** `/access` maps a main-server role to an authority tier
  (Supervisor → Admin); holding the role unlocks every bot command up to that tier, resolved
  live from the member's roles — so a community runs bot access off its existing staff roles
  instead of granting each person by hand. Losing the role loses the access immediately.
- **A reconciliation engine.** Desired state − actual state = required changes.
  Deterministic, idempotent, and it never removes a role whose correct value it cannot
  compute.
- **Granular permissions.** Capability + scope (global / guild) + a maximum manageable
  authority level, checked in the backend on every action from both Discord and the
  website.
- **Immutable audit trail.** Every action, successful or denied, with actor, before/after
  state, reason and correlation id.
- **A job queue.** BullMQ with exponential backoff, permanent-failure detection, per-member
  locking, scheduled reconciliation and a maximum-change threshold that pauses anything
  that looks like a mass removal.
- **A website-ready REST API.** Session auth over Discord OAuth, CSRF protection, rate
  limits, pagination and the same authorization rules as the bot.

## Architecture

```
Community Website ──────┐
                        ├─► Backend API ─┐
Discord slash commands ─┘                │
         │                               ▼
         │                        PostgreSQL (source of truth)
         │                               │
         │                               ▼
         └──────────────────────► BullMQ / Redis
                                         │
                                         ▼
                                 Worker (reconciliation)
                                         │
                                         ▼
                                 Approved Discord guilds
```

Three processes, one shared brain:

| Process       | Responsibility                                                                          |
| ------------- | --------------------------------------------------------------------------------------- |
| `apps/bot`    | Discord events and slash commands. Observes and commands; never writes roles itself.    |
| `apps/api`    | Authenticated HTTP for the future dashboard. Never holds the bot token.                 |
| `apps/worker` | The only process that writes roles to Discord. Runs the queue and the scheduled sweeps. |

All three are thin adapters over `packages/core`, which holds every authorization
decision, database write and role calculation. That is what stops the website and the bot
from ever disagreeing about what somebody is allowed to do.

| Package                   | Responsibility                                                      |
| ------------------------- | ------------------------------------------------------------------- |
| `packages/shared`         | Enums, error taxonomy, capability catalogue, environment validation |
| `packages/logging`        | Pino logger with a secret-redaction list                            |
| `packages/validation`     | Zod schemas for every input, used at both boundaries                |
| `packages/database`       | Prisma client, transactions, pagination helpers                     |
| `packages/authorization`  | Pure capability/scope/ceiling evaluation, plus grant rules          |
| `packages/discord`        | Role gateway over discord.js, hierarchy pre-flight, in-memory mock  |
| `packages/reconciliation` | Desired-state computation and diffing (pure, no I/O)                |
| `packages/queue`          | BullMQ queues, Redis sync markers, distributed locks                |
| `packages/core`           | Business services shared by every process                           |

Detailed design, including the risk analysis that shaped it, is in
[docs/implementation-plan.md](docs/implementation-plan.md) and
[docs/architecture.md](docs/architecture.md).

## Quick start

Requirements: Node.js 20.11+, Docker (or a local PostgreSQL 16 and Redis 7).

```bash
git clone <this repository>
cd florida-roleplay-manager
npm install

cp .env.example .env          # then fill in DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID

docker compose up -d postgres redis
npm run prisma:migrate        # create the schema
npm run db:seed -- --demo     # capabilities, settings, and a demo community

npm run commands:register -- --guild   # register slash commands in DEV_GUILD_IDS
npm run dev:worker &          # applies role changes
npm run dev:bot &             # Discord gateway
npm run dev:api &             # REST API on :4000
```

Full walkthrough: [docs/development.md](docs/development.md).
Discord application setup and required permissions:
[docs/discord-setup.md](docs/discord-setup.md).

## Commands

```
/setup        department · community
/guild        list · register · remove · settings · status
/mapping      create · list · view · edit · test · enable · disable · remove
              approvals · approve · reject
/role         manage · list · unmanage · grant · revoke · grants
/resync       member · guild · all · preview · status
/member       lookup · link · unlink
/audit        member · mapping · recent · failures · retry
/permissions  grant · revoke · view
/system       health
```

`/setup department` and `/setup community` provision a whole server in one step — each opens
a modal, previews exactly what it will create, and on confirmation builds the categories,
channels, roles and permission overwrites from an editable template
([`department.js`](packages/core/src/templates/department.js) /
[`community.js`](packages/core/src/templates/community.js)). `community` registers the server
as your `MAIN_COMMUNITY` hub; `department` registers the server, marks its member role as
managed, and maps the main community into it. Both are idempotent: re-running only creates
what is missing, so they double as repair commands.

Anything destructive or large asks for confirmation first, and guild/global resyncs show a
real preview — computed by the same planner that will do the work — before anything is
applied.

## Testing

```bash
npm test              # everything
npm run test:coverage # with coverage
npm run lint
```

The unit suite runs with no services at all. The integration suites need PostgreSQL and
Redis and will skip themselves with a clear message if those are not reachable. Discord is
never contacted: an in-memory gateway models role hierarchy, integration-owned roles,
missing members, deleted roles, rate limits and permission failures.

Coverage of the specification's required cases lives in `tests/`:

| Area                                           | Where                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| One-way and two-way mappings, add/removal sync | `tests/unit/reconciliation.test.js`, `tests/integration/mapping-sync.test.js`         |
| Manual grants, expiry and revocation           | `tests/unit/reconciliation.test.js`, `tests/integration/sync-runner.test.js`          |
| Loop protection                                | `tests/integration/loop-protection.test.js`, `tests/integration/mapping-sync.test.js` |
| Circular mapping rejection                     | `tests/unit/cycle-detection.test.js`, `tests/integration/services.test.js`            |
| Protected roles and two-person approval        | `tests/unit/preflight.test.js`, `tests/integration/approvals.test.js`                 |
| Guild allowlist enforcement                    | `tests/integration/services.test.js`, `tests/integration/api.test.js`                 |
| Guild scopes and permission escalation         | `tests/unit/authorization.test.js`, `tests/integration/services.test.js`              |
| Dry run and reconciliation idempotency         | `tests/integration/sync-runner.test.js`                                               |
| Unmanaged role preservation                    | `tests/unit/reconciliation.test.js`, `tests/integration/sync-runner.test.js`          |
| Discord hierarchy failures                     | `tests/unit/preflight.test.js`, `tests/integration/sync-runner.test.js`               |
| Job retry behaviour                            | `tests/unit/worker-retry.test.js`                                                     |
| Audit log creation                             | `tests/integration/services.test.js`, `tests/integration/sync-runner.test.js`         |

## Documentation

- [Architecture](docs/architecture.md) — how the pieces fit, and the rules that hold
- [Implementation plan and risk analysis](docs/implementation-plan.md)
- [Local development](docs/development.md)
- [Discord application setup](docs/discord-setup.md)
- [Environment variables](docs/environment.md)
- [Database and migrations](docs/database.md)
- [Production deployment](docs/deployment.md)
- [Security considerations](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Backup and recovery](docs/backup-recovery.md)

## Project status

Everything in scope is implemented and covered by tests: the allowlist, the member model,
managed role definitions, one-way and two-way mappings, add and removal synchronization,
manual grants with expiry, Redis loop protection, every slash command listed above,
internal permission checks, audit logging, BullMQ jobs, failure reporting, the REST API,
the Docker Compose environment and the automated tests.

Deliberately **not** built yet:

- The Next.js + Tailwind administration dashboard. The API is shaped for it (session
  cookies, CSRF, pagination, `GET /api/me` returning the caller's capabilities) but no
  frontend exists.

Three things worth knowing before running this against a live community:

- **The bot has never been run against a real Discord server in this repository.** Every
  Discord interaction is covered by the mock gateway and the discord.js builders validate
  the command definitions, but the first real deployment should start with
  `DISCORD_MOCK=true` and `SYNC_DRY_RUN_DEFAULT=true`.
- **The Docker image has not been built here.** `docker-compose.yml` passes
  `docker compose config`, but the environment this was developed in cannot reach the
  container registry, so `docker build` is unverified. The database migration, seed, all
  three services and the whole test suite were run directly against local PostgreSQL and
  Redis instead.
- **Register the guilds before inviting the bot widely.** In production the bot leaves any
  server that is not on the allowlist.

## Licence

Internal community project. No licence granted for redistribution.
