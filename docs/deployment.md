# Production deployment

## Before anything else

1. **Generate real secrets.** `openssl rand -hex 32` for `SESSION_SECRET`. Reset the bot
   token if it has ever been in a shared document or a commit.
2. **Set `NODE_ENV=production`.** This forces `DEV_MODE` and `DISCORD_MOCK` off regardless
   of what the environment file says, and makes missing or weak secrets fatal at startup.
3. **Set `COOKIE_SECURE=true`.** The API refuses to start in production without it.
4. **Register the approved guilds first.** In production the bot leaves any server that is
   not on the allowlist.

## Docker Compose

The supplied `docker-compose.yml` runs the whole platform: PostgreSQL, Redis, a one-shot
migration job, and the three services. All three run the same image, selected by command,
so they cannot drift apart.

```bash
cp .env.example .env      # fill in real values
docker compose build
docker compose up -d
docker compose logs -f worker
```

`migrate` runs `prisma migrate deploy` and must exit successfully before the api, bot and
worker start. PostgreSQL and Redis both have health checks that the services wait on.

Seed the capability catalogue and the bootstrap administrators once:

```bash
docker compose run --rm api node prisma/seed.js
```

Then register the global slash commands:

```bash
docker compose run --rm bot npm run commands:register
```

## Running without Docker

Any process supervisor works — systemd, PM2, Kubernetes. Three units:

```bash
node apps/api/src/index.js
node apps/bot/src/index.js
node apps/worker/src/index.js
```

All three handle `SIGTERM` and `SIGINT`: they stop accepting work, let in-flight jobs
finish, close the database and Redis connections, and exit 0.

## Scaling

| Component    | Scaling                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **api**      | Horizontal. Stateless; sessions are in Redis.                                                                                                                                                                            |
| **worker**   | Horizontal. BullMQ distributes jobs, per-member Redis locks prevent two workers fighting over the same person. Raise `WORKER_CONCURRENCY` before adding replicas — Discord rate limits are per-bot, not per-process.     |
| **bot**      | **Single instance**, unless you implement Discord sharding. Two unsharded gateway connections receive every event twice. Loop protection is safe under this (markers are single-use), but the duplicated work is wasted. |
| **postgres** | Vertical, plus a read replica if the dashboard grows.                                                                                                                                                                    |
| **redis**    | Single instance is normally ample. It holds queues, markers, locks and sessions; losing it loses in-flight jobs, not committed data.                                                                                     |

## Health checks

| Endpoint            | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `GET /health`       | Liveness — the process is up                                   |
| `GET /health/ready` | Readiness — PostgreSQL and Redis both reachable; 503 otherwise |

Use `/health` for restart policies and `/health/ready` for load-balancer membership.

`/system health` in Discord gives the fuller picture: queue depth, stuck jobs, unresolved
issues by type, and whether development affordances are active.

## Reverse proxy

Terminate TLS in front of the API. If you do, set `API_TRUST_PROXY=true` so that client IP
addresses in rate limiting and audit records are the real ones — and make sure only the
proxy can reach the API port, because with that flag on, `X-Forwarded-For` is believed.

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`CORS_ALLOWED_ORIGINS` must list the dashboard's origin exactly. Credentialed requests
cannot use a wildcard.

## First deployment: go slowly

The synchronization engine can change roles for the entire community in one job. Ease into
it:

1. Deploy with `SYNC_DRY_RUN_DEFAULT=true`. Every job plans and records but changes
   nothing.
2. Register the guilds, declare the managed roles with `/role manage`, then create the
   mappings — disabled at first.
3. Run `/resync preview member:<someone>` and read the plan. Confirm the adds and removals
   are what you expect.
4. Enable one mapping, run `/resync preview guild:<one guild>` and check the totals —
   particularly the removal count.
5. Turn `SYNC_DRY_RUN_DEFAULT` off. Synchronize one member, then one guild.
6. Lower `SYNC_MAX_REMOVALS_THRESHOLD` while you build confidence; a paused job is a
   nuisance, an unintended mass removal is an incident.
7. Leave scheduled reconciliation running. It is what keeps drift from accumulating.

## Upgrades

```bash
git pull
npm ci
npm run prisma:deploy     # or let the migrate service do it
docker compose up -d --build
```

Migrations are additive wherever possible. Take a backup before deploying one that drops or
renames a column — see [backup-recovery.md](backup-recovery.md).

## What to monitor

- `sync_issues` where `resolved = false`, grouped by type — the single best signal
- Jobs stuck in `RUNNING` for over an hour, and any job in `PAUSED`
- BullMQ failed-job counts per queue
- Redis memory and connectivity: without it, loop protection fails safe by ignoring role
  events, so drift accumulates until it returns
- Log lines at `warn` and above; every one carries a `requestId` that ties it to an audit
  record
