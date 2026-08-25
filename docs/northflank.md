# Migrating from Railway to Northflank

Moving a **running** platform, so the order matters more than the individual steps. The
database is the only thing that cannot be recreated, and Discord will happily run two bots
against the same guild if you let it.

## What maps to what

| Railway                      | Northflank                                                    | Notes                                                                       |
| ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Service (from repo)          | **Combined service**                                          | Builds from Git and deploys in one object.                                  |
| Postgres / Redis plugin      | **Addon**                                                     | Managed. Links into secret groups rather than being copied by hand.         |
| Per-service Variables        | **Secret group**                                              | One group, inherited by every service and job. This is the big improvement. |
| Pre-Deploy Command           | **Release flow** with a migration node before the deploy node | A real pipeline object rather than a text field.                            |
| `${{Postgres.DATABASE_URL}}` | Addon linked to a secret group, with an **alias**             | Same idea, different mechanics.                                             |
| `*.up.railway.app`           | `*.code.run`                                                  | Both on the Public Suffix List — see below.                                 |

## Read this before planning domains

`*.code.run` is on the [Public Suffix List](https://northflank.com/docs/v1/application/domains/domains-on-northflank),
deliberately: Northflank puts it there so one customer's subdomain cannot set cookies for
another's. The consequence for you is that **`site.code.run` and `api.code.run` are treated
as different root domains**, so the session cookie will not be shared between them.

Your dashboard will therefore **not work on Northflank's generated domains at all**. This
is not a configuration mistake to debug — it is the platform working as designed.
Railway's `*.up.railway.app` has the same property, which is why the same constraint
applied there.

So custom domains are a **hard requirement**, not a nice-to-have:

```
floridarp.com          → frontend service
api.floridarp.com      → api service
```

The public roster endpoints (`/api/rosters`) work on any domain — they carry no session.
Everything authenticated needs the shared parent domain.

---

## Order of operations

The safe sequence is: build the new environment empty → copy the data → cut over → stop the
old one. The two windows worth caring about are marked.

### 1. Create the project and addons

Northflank → **New Project**, then inside it:

- **Addons → PostgreSQL** — same major version as Railway's. Check with
  `SELECT version();` against the Railway database first.
- **Addons → Redis**.

Enable **public access** on the Postgres addon for now. You need it to restore into, and
you turn it off again afterwards.

### 2. Create a secret group

**Secrets → Create secret group**, and link both addons to it. Linking is what makes
Northflank rotate credentials into your services automatically instead of you pasting a
connection string that later goes stale.

When linking, set **aliases** so the addon's variables arrive under the names this
application actually reads:

| Addon variable          | Alias it must have |
| ----------------------- | ------------------ |
| Postgres connection URI | `DATABASE_URL`     |
| Redis connection URI    | `REDIS_URL`        |

Then add the rest as plain secrets in the same group:

```bash
NODE_ENV=production
DEV_MODE=false
LOG_LEVEL=info

DISCORD_BOT_TOKEN=<same token as Railway>
DISCORD_CLIENT_ID=<client id>
DISCORD_CLIENT_SECRET=<client secret>
GLOBAL_ADMIN_DISCORD_IDS=<your discord user id>

SESSION_SECRET=<48 random chars>
SESSION_TTL_SECONDS=86400
COOKIE_SECURE=true
API_TRUST_PROXY=true
CORS_ALLOWED_ORIGINS=https://floridarp.com,https://www.floridarp.com
DISCORD_OAUTH_REDIRECT_URI=https://api.floridarp.com/api/auth/discord/callback

SYNC_DRY_RUN_DEFAULT=false
SYNC_MAX_REMOVALS_THRESHOLD=50
WORKER_CONCURRENCY=5
RECONCILE_CRON=0 */6 * * *
```

Copy `SESSION_SECRET` from Railway if you want existing dashboard sessions to survive the
move. Generate a new one if you would rather everybody signed in again — there is no wrong
answer, but a _changed_ secret means every session breaks at cutover, so decide on purpose.

`SYNC_DRY_RUN_DEFAULT` should match whatever Railway currently has. Do not quietly flip it
during a migration; one change at a time.

### 3. Create the three services

Three **Combined services**, all pointed at the same repo and branch (`main`), all building
`docker/Dockerfile`. They differ only in the run command — that is the whole point of the
single-image design.

|              | `api`                        | `bot`                        | `worker`                        |
| ------------ | ---------------------------- | ---------------------------- | ------------------------------- |
| Run command  | `node apps/api/src/index.js` | `node apps/bot/src/index.js` | `node apps/worker/src/index.js` |
| Port         | 4000, HTTP, **public**       | none                         | none                            |
| Health check | `/health`                    | none                         | none                            |
| Secret group | inherit                      | inherit                      | inherit                         |

The API binds to whatever `PORT` Northflank injects, falling back to 4000, so you do not
have to set `API_PORT` yourself.

**Set the bot and worker to 0 replicas for now.** They must not connect to Discord while
Railway's copies are still running — see step 5.

### 4. Copy the database — downtime window 1

This is the only irreplaceable thing you own, so it gets its own window.

**Stop writes first.** Scale Railway's `bot` and `worker` to zero. Leave `api` running or
not; it barely matters, but nothing should be writing while you dump.

```bash
# From your machine, with both connection strings to hand.
pg_dump --no-owner --no-privileges --format=custom \
  "$RAILWAY_DATABASE_URL" > frm-$(date +%Y%m%d-%H%M).dump

# Restore into the Northflank addon.
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname "$NORTHFLANK_DATABASE_URL" frm-*.dump
```

`--no-owner --no-privileges` matters: the role names differ between the two platforms and
without those flags the restore fails on every `ALTER ... OWNER TO`.

Verify before going further:

```bash
psql "$NORTHFLANK_DATABASE_URL" -c "\dt"
psql "$NORTHFLANK_DATABASE_URL" -c "SELECT count(*) FROM approved_guilds;"
psql "$NORTHFLANK_DATABASE_URL" -c "SELECT count(*) FROM users;"
psql "$NORTHFLANK_DATABASE_URL" -c "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 3;"
```

That last one is the important one. The migration history travels with the dump, so
Northflank's first deploy should report **no pending migrations**. If it tries to re-run
`init`, you restored into the wrong database or the dump did not include
`_prisma_migrations` — stop and work out which before letting it touch anything.

**Do not migrate Redis.** It holds sessions, the job queue and the loop-protection markers,
all of which are either disposable or actively harmful to move half-copied. Sessions mean
people sign in again. Markers expire in 60 seconds. The queue is the one to think about:
drain it before you dump by leaving the Railway worker running until `/sync/jobs` shows
nothing pending, _then_ scaling to zero.

### 5. Cut over — downtime window 2

**Only one bot may hold the Discord gateway connection.** Two bots with the same token
both receive every event, both act on it, and both write markers the other cannot see. That
is exactly the loop protection this platform is built around, defeated by running two copies
of it. So:

1. Railway `bot` and `worker` → **0 replicas**. (Already done in step 4.)
2. Confirm the bot shows offline in Discord.
3. Northflank `bot` and `worker` → **1 replica** each.
4. Watch the logs. The bot reconciles `GLOBAL_ADMIN_DISCORD_IDS` on boot, so you should see
   it grant capabilities and then go quiet.

### 6. Migrations, properly

For the cutover the schema is already correct — it came over in the dump. For every deploy
_after_ this, set up a **release flow** so migrations run before the new code:

**Pipelines → Release flow**, with the nodes in this order:

```
build  →  run migration job  →  deploy api  →  deploy bot  →  deploy worker
```

The migration node runs `npx prisma migrate deploy`. Put it on exactly one node — three
containers racing to migrate the same database is the failure this ordering exists to
prevent.

Northflank's release flows also have a **backup** node. Put one before the migration.
Migrations here are additive by convention, but "additive by convention" is not a backup.

### 7. Domains

- `api` service → **Domains → add** `api.floridarp.com`, then the CNAME at your DNS
  provider.
- Frontend service → `floridarp.com` (and `www` if you use it).
- Northflank issues the certificates.

Then update **both**:

- `DISCORD_OAUTH_REDIRECT_URI` in the secret group.
- **OAuth2 → Redirects** in the Discord developer portal — character for character.

You can leave the old Railway redirect registered until you are confident, then remove it.

### 8. Turn public access off

Back on the Postgres addon, disable public access now the restore is done. It only existed
so you could reach it from your laptop.

---

## The frontend

A fourth **Combined service** from the website repo. Northflank's buildpack detection
recognises Vite and React without a Dockerfile, and the app builds to `dist`.

- Port **80**, HTTP, public.
- Custom domain `floridarp.com`.
- One environment variable: `VITE_API_URL=https://api.floridarp.com`.

Do not give the frontend the secret group. It needs one public URL and nothing else — no
database credentials, no bot token. A build-time variable in a browser app is not a secret;
it ships to every visitor.

---

## Verification

```bash
curl https://api.floridarp.com/health          # {"status":"ok"}
curl https://api.floridarp.com/health/ready    # database and redis both true
curl https://api.floridarp.com/api/rosters     # public, no session needed
```

Then in Discord:

- `/system health` → green.
- `/guild list` → your servers are still there. This is the real proof the data came over.
- `/audit recent` → your history is intact.

Commands do **not** need re-registering. They are registered against the Discord
application, not the host, so they follow the token.

---

## Rollback

Until you delete the Railway project, rollback is: Northflank `bot` and `worker` to 0
replicas, Railway's back to 1, DNS back. **Any data written on Northflank after cutover is
lost by doing that**, which is why the write-stopping in step 4 matters — it keeps the
Railway database a valid restore point.

Keep Railway alive and paid for a week. It is the cheapest insurance you will buy.

## Things that will bite you

| Symptom                                    | Cause                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Dashboard 401s on every request            | Using `*.code.run` domains. It is on the Public Suffix List; the cookie is never shared. Custom domains are mandatory. |
| Bot acts on everything twice               | Both Railway and Northflank bots are running. Only one may hold the gateway.                                           |
| First deploy tries to run `init`           | The dump did not carry `_prisma_migrations`, or you restored into the wrong database.                                  |
| `pg_restore` fails on `ALTER ... OWNER TO` | Missing `--no-owner --no-privileges`.                                                                                  |
| Everyone signed out after cutover          | `SESSION_SECRET` differs from Railway's. Expected if you generated a new one.                                          |
| Jobs queued on Railway never ran           | Redis was not drained before the move. Run `/resync all` and `/roster sync` to recompute.                              |
| Service boots then exits immediately       | A required secret is missing. Each process validates at boot and names what it needs.                                  |

Sources:
[Deploy PostgreSQL on Northflank](https://northflank.com/docs/v1/application/databases-and-persistence/deploy-databases-on-northflank/deploy-postgresql-on-northflank) ·
[Connect database secrets to workloads](https://northflank.com/docs/v1/application/databases-and-persistence/connect-database-secrets-to-workloads) ·
[Manage secret groups](https://northflank.com/docs/v1/application/secure/manage-secret-groups) ·
[Run migrations](https://northflank.com/docs/v1/application/release/run-migrations) ·
[Create a pipeline and release flow](https://northflank.com/docs/v1/application/release/create-a-pipeline-and-release-flow) ·
[Domains on Northflank](https://northflank.com/docs/v1/application/domains/domains-on-northflank) ·
[Deploy a React app on Northflank](https://northflank.com/guides/deploy-react-app-on-northflank)
