# Environment variables

Every variable is validated at startup by `packages/shared/src/env.js`. Invalid or missing
required values abort the process rather than degrading silently, and each service
declares its own requirements — the worker does not need OAuth secrets, the API does not
need a bot token.

An empty value means "not configured", not "configured as an empty string".

## Required per service

| Service                    | Must have                                                             |
| -------------------------- | --------------------------------------------------------------------- |
| bot                        | `DATABASE_URL`, `REDIS_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` |
| worker                     | `DATABASE_URL`, `REDIS_URL`, `DISCORD_BOT_TOKEN`                      |
| api                        | `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`                         |
| scripts (seed, migrations) | `DATABASE_URL`                                                        |

## Runtime

| Variable               | Default       | Notes                                                                                                   |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `development` | `development` \| `production` \| `test`                                                                 |
| `DEV_MODE`             | `false`       | Relaxes unapproved-guild auto-leave and allows demo seeding. **Forced off when `NODE_ENV=production`.** |
| `DEV_GUILD_IDS`        | empty         | Comma-separated guild IDs for instant per-guild command registration                                    |
| `DISCORD_MOCK`         | `false`       | Reads hit Discord, writes are logged and skipped. **Forced off in production.**                         |
| `SYNC_DRY_RUN_DEFAULT` | `false`       | Every job defaults to dry run. Useful for a first deployment.                                           |
| `LOG_LEVEL`            | `info`        | `trace`…`fatal`, or `silent`                                                                            |

## Data stores

| Variable       | Default                  | Notes                                                     |
| -------------- | ------------------------ | --------------------------------------------------------- |
| `DATABASE_URL` | —                        | PostgreSQL connection string. Secret; redacted from logs. |
| `REDIS_URL`    | `redis://localhost:6379` | Queues, sync markers, locks, sessions                     |

## Discord

| Variable                     | Default | Notes                                                                |
| ---------------------------- | ------- | -------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`          | —       | **Secret.** Bot and worker only. Never reaches the API or a browser. |
| `DISCORD_CLIENT_ID`          | —       | Application ID, used for command registration                        |
| `DISCORD_CLIENT_SECRET`      | —       | **Secret.** API only, for the OAuth login flow.                      |
| `DISCORD_OAUTH_REDIRECT_URI` | —       | Must match the redirect registered in the developer portal           |
| `GLOBAL_ADMIN_DISCORD_IDS`   | empty   | Bootstrapped with `system.manage` at global scope by the seed        |
| `ADMIN_ALERT_WEBHOOK_URL`    | —       | **Secret.** Optional alert destination.                              |

## API

| Variable               | Default    | Notes                                                                                                                     |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `API_HOST`             | `0.0.0.0`  |                                                                                                                           |
| `API_PORT`             | `4000`     |                                                                                                                           |
| `SESSION_SECRET`       | —          | **Secret.** Minimum 32 characters in production; the example placeholder is rejected. `openssl rand -hex 32`              |
| `SESSION_TTL_SECONDS`  | `86400`    |                                                                                                                           |
| `COOKIE_SECURE`        | `false`    | **Must be true in production** — startup fails otherwise                                                                  |
| `CORS_ALLOWED_ORIGINS` | empty      | Explicit origin allowlist; wildcards cannot be used with cookies                                                          |
| `API_PORT`             | `4000`     | Falls back to `PORT` when unset, which is how Railway, Render, Heroku and Fly assign it                                   |
| `API_TRUST_PROXY`      | `false`    | Only enable behind a trusted reverse proxy — it makes `X-Forwarded-For` authoritative for rate limiting and audit records |
| `RATE_LIMIT_MAX`       | `120`      | Requests per window, keyed on session then IP                                                                             |
| `RATE_LIMIT_WINDOW`    | `1 minute` |                                                                                                                           |

Session cookies are `SameSite=Lax`, so the API has to be served from the same registrable
domain as the website (`api.example.com` alongside `example.com`). On a different domain
the browser drops the cookie on every cross-site request and the dashboard sees nothing but
401s, with no CORS error to point at the cause. See
[website integration](website-integration.md).

## Synchronization

| Variable                      | Default       | Notes                                                                                                                                                                                   |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_MARKER_TTL_SECONDS`     | `60`          | Must exceed the worst-case delay between applying a change and receiving its Discord event. Too short causes redundant (harmless) jobs; too long delays recognition of genuine changes. |
| `SYNC_MAX_REMOVALS_THRESHOLD` | `50`          | A job planning more removals than this pauses instead of executing. Overridable at runtime via the `sync.maxRemovalsThreshold` system setting.                                          |
| `SYNC_LOCK_TTL_SECONDS`       | `30`          | Per-member lock lifetime while a job applies changes                                                                                                                                    |
| `WORKER_CONCURRENCY`          | `5`           | Concurrent jobs per queue. Raising this raises Discord rate-limit pressure.                                                                                                             |
| `RECONCILE_CRON`              | `0 */6 * * *` | Scheduled reconciliation of every active member (UTC)                                                                                                                                   |
| `MAPPING_VALIDATION_CRON`     | `0 3 * * *`   | Daily mapping and role validation sweep (UTC)                                                                                                                                           |

## Secrets

Secrets live only in environment variables — never in the database, never in a commit,
never in an API response. The logger redacts `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`,
`SESSION_SECRET`, `DATABASE_URL`, `ADMIN_ALERT_WEBHOOK_URL`, `authorization` and `cookie`
headers, and any field named `token`, `password` or `secret` at any nesting depth.

`.env.example` documents every variable with safe placeholder values and is the file to
keep in sync when adding a new one.
