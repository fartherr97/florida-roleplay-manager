# Local development

## Requirements

- Node.js 20.11 or newer (22 recommended)
- Docker and Docker Compose, or a local PostgreSQL 16 and Redis 7
- A Discord application — see [discord-setup.md](discord-setup.md)

## First run

```bash
npm install
cp .env.example .env
```

Fill in at minimum:

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=...
DEV_GUILD_IDS=<your test guild id>,<a second test guild id>
GLOBAL_ADMIN_DISCORD_IDS=<your Discord user id>
DEV_MODE=true
DISCORD_MOCK=true          # start here: real reads, no real writes
SYNC_DRY_RUN_DEFAULT=true  # and no real changes either
```

Start the backing services and prepare the database:

```bash
docker compose up -d postgres redis
npm run prisma:migrate       # creates the schema and generates the client
npm run db:seed -- --demo    # capabilities, settings, admins, and a demo community
```

`--demo` builds two departments, three guilds, a rank ladder, managed roles, a one-way and
a two-way mapping, and three members — enough to exercise every command without touching a
real server. It is refused when `NODE_ENV=production`.

Register the slash commands. Guild-scoped registration is instant; global registration can
take up to an hour, so use `--guild` while developing:

```bash
npm run commands:register -- --guild
```

Run the three processes in separate terminals:

```bash
npm run dev:worker
npm run dev:bot
npm run dev:api
```

`node --watch` restarts each on file changes.

## Development mode

`DEV_MODE=true` (only honoured outside production) changes four things:

- the bot does **not** leave guilds that are missing from the allowlist, it only warns;
- `DEV_GUILD_IDS` is where per-guild command registration goes;
- `npm run db:seed -- --demo` is permitted;
- combined with `DISCORD_MOCK=true`, all role _writes_ are logged and skipped while reads
  still hit the real API — so plans are real and consequences are not.

`SYNC_DRY_RUN_DEFAULT=true` additionally makes every job default to dry run. Turn these
off one at a time as you gain confidence.

## Working without Discord entirely

The whole synchronization engine can be exercised with no Discord connection at all: the
unit suite and most integration tests drive an in-memory `MockRoleGateway` that models role
hierarchy, integration-owned roles, missing members, deleted roles and API failures.

```bash
npm test                                  # everything
npx vitest run tests/unit                 # no services needed at all
npx vitest watch tests/unit/reconciliation.test.js
```

Integration tests use a separate database. Create it once:

```bash
createdb frm_test    # or: docker compose exec postgres createdb -U frm frm_test
TEST_DATABASE_URL="postgresql://frm:frm_local_password@localhost:5432/frm_test?schema=public" \
  npx prisma migrate deploy
```

They skip themselves with a clear message if PostgreSQL or Redis is unreachable.

## Useful commands

| Command                                | What it does                                |
| -------------------------------------- | ------------------------------------------- |
| `npm run lint` / `npm run lint:fix`    | ESLint over everything                      |
| `npm run format`                       | Prettier                                    |
| `npm test`                             | Full suite                                  |
| `npm run test:coverage`                | Coverage report in `coverage/`              |
| `npm run prisma:migrate`               | Create and apply a migration                |
| `npm run prisma:studio`                | Browse the database                         |
| `npm run prisma:reset`                 | Drop and rebuild (destroys data)            |
| `npm run db:seed`                      | Capabilities, settings and bootstrap admins |
| `npm run commands:register -- --guild` | Register commands in `DEV_GUILD_IDS`        |
| `npm run commands:clear -- --guild`    | Remove them again                           |

## Adding things

**A new slash command.** Create `apps/bot/src/commands/<name>.js` exporting `data`
(a `SlashCommandBuilder`) and `execute(interaction, { ctx, gateway })`, then add it to the
list in `apps/bot/src/commands/index.js`. Routing, the allowlist gate, rate limiting,
autocomplete and error rendering are already wired.

**A new capability.** Add it to `packages/shared/src/capabilities.js` with its category,
allowed scopes and minimum authority level, then re-run `npm run db:seed`. The catalogue is
the single definition; the database table is a projection of it.

**A new business rule.** It belongs in `packages/core`, not in a command or a route. If you
find yourself writing an authorization check in `apps/`, that is the signal it is in the
wrong place — the other boundary will not have it.

**A schema change.** Edit `prisma/schema.prisma`, run `npm run prisma:migrate`, and if you
touched an enum, update `packages/shared/src/enums.js` too. The parity test will fail if
you forget.

## Conventions

- ES modules, Node 20+ syntax, no build step. What you run is what you wrote.
- Zod at every boundary; nothing from Discord or the browser is trusted.
- Comments explain _why_, not _what_. The tests document behaviour.
- No circular dependencies between packages — enforced by `import/no-cycle`.
