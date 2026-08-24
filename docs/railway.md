# Deploying to Railway

A walkthrough for getting the platform running on Railway. Assumes you have a Railway
account and this repository on GitHub.

You end up with **five services in one Railway project**:

| Service  | What it is                              | Public? |
| -------- | --------------------------------------- | ------- |
| Postgres | Railway's managed database              | No      |
| Redis    | Railway's managed Redis                 | No      |
| `api`    | The REST API the website calls          | **Yes** |
| `bot`    | Discord gateway: commands and events    | No      |
| `worker` | The only process that writes to Discord | No      |

`api`, `bot` and `worker` are the **same image** built from `docker/Dockerfile`. They differ
only in their start command, which is what guarantees all three run identical business
logic. On Railway that means three services pointed at the same repo with three different
start commands — not three Dockerfiles.

---

## 1. Create the project and the datastores

1. Railway → **New Project** → **Deploy from GitHub repo** → pick this repository. Let the
   first build fail or cancel it; you will configure it properly in step 3.
2. In the project, **+ New** → **Database** → **Add PostgreSQL**.
3. **+ New** → **Database** → **Add Redis**.

Railway generates connection strings for both. You never copy them by hand — step 4 wires
them in with reference variables so they keep working if Railway rotates a password.

## 2. Get your Discord credentials

From the [Discord developer portal](https://discord.com/developers/applications), on your
application:

- **Bot → Token** → _Reset Token_, copy it. This is `DISCORD_BOT_TOKEN`.
- **OAuth2 → Client ID** → `DISCORD_CLIENT_ID`.
- **OAuth2 → Client Secret** → _Reset Secret_, copy it. This is `DISCORD_CLIENT_SECRET`.
- **Bot → Privileged Gateway Intents** → enable **Server Members Intent**. The bot cannot
  see role changes without it, so nothing works. Leave Message Content off.

You also need your own Discord user id for `GLOBAL_ADMIN_DISCORD_IDS` — enable Developer
Mode in Discord (Settings → Advanced), then right-click yourself → _Copy User ID_. Without
this you will have a running bot that nobody has permission to configure.

## 3. Configure the `api` service

Rename the service Railway created from the repo to `api`. Then under **Settings**:

- **Build → Builder**: `Dockerfile`
- **Build → Dockerfile Path**: `docker/Dockerfile`
- **Deploy → Start Command**: `node apps/api/src/index.js`
- **Deploy → Pre-Deploy Command**: `npx prisma migrate deploy`
- **Deploy → Healthcheck Path**: `/health`
- **Networking → Public Networking**: _Generate Domain_

The **pre-deploy command is how migrations run**. Railway executes it once per deploy,
before the new version takes traffic, and aborts the deploy if it fails. Put it on `api`
only — running it on all three would have three containers racing to migrate the same
database on every deploy.

## 4. Set the `api` variables

Under **Variables** on the `api` service. Use Railway's **Raw Editor** and paste this,
substituting your own values:

```bash
NODE_ENV=production
DEV_MODE=false
LOG_LEVEL=info

DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

DISCORD_CLIENT_ID=<your client id>
DISCORD_CLIENT_SECRET=<your client secret>
DISCORD_BOT_TOKEN=<your bot token>
GLOBAL_ADMIN_DISCORD_IDS=<your discord user id>

SESSION_SECRET=<paste a 48-character random string>
SESSION_TTL_SECONDS=86400
COOKIE_SECURE=true
API_TRUST_PROXY=true
CORS_ALLOWED_ORIGINS=https://your-website.com

DISCORD_OAUTH_REDIRECT_URI=https://<your-api-domain>/api/auth/discord/callback

SYNC_DRY_RUN_DEFAULT=true
```

The `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}` syntax is Railway's — it
references the other services rather than hard-coding a password.

Generate the session secret with:

```bash
openssl rand -base64 36
```

`SESSION_SECRET` shorter than 32 characters is **refused at boot in production**, on
purpose. So is `COOKIE_SECURE=false`.

Note `SYNC_DRY_RUN_DEFAULT=true` — leave it on for the first deploy. The bot will compute
every change and record it without touching anybody's roles, which is how you find a
misconfiguration before it renames forty people. Turn it off when you have seen a dry run
you agree with.

Fill in `DISCORD_OAUTH_REDIRECT_URI` with the domain Railway generated in step 3, then add
that exact URL to **OAuth2 → Redirects** in the Discord portal. It must match character for
character, trailing slash included.

## 5. Add the `bot` and `worker` services

**+ New** → **GitHub Repo** → the same repository. Twice.

Configure each exactly like `api` with three differences: no public domain, no healthcheck,
no pre-deploy command.

|                   | `bot`                        | `worker`                        |
| ----------------- | ---------------------------- | ------------------------------- |
| Start Command     | `node apps/bot/src/index.js` | `node apps/worker/src/index.js` |
| Dockerfile Path   | `docker/Dockerfile`          | `docker/Dockerfile`             |
| Public networking | Off                          | Off                             |
| Pre-deploy        | _(none)_                     | _(none)_                        |

Variables for both — they do not need the session or CORS settings, only what talks to
Discord and the datastores:

```bash
NODE_ENV=production
DEV_MODE=false
LOG_LEVEL=info

DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

DISCORD_BOT_TOKEN=<your bot token>
DISCORD_CLIENT_ID=<your client id>
GLOBAL_ADMIN_DISCORD_IDS=<your discord user id>

SYNC_DRY_RUN_DEFAULT=true
SYNC_MAX_REMOVALS_THRESHOLD=50
WORKER_CONCURRENCY=5
RECONCILE_CRON=0 */6 * * *
```

Each service validates its own requirements at boot and refuses to start rather than
running half-configured, so a missing variable shows up immediately in the deploy log with
the name of what is missing.

## 6. Invite the bot

```
https://discord.com/api/oauth2/authorize
  ?client_id=<DISCORD_CLIENT_ID>
  &permissions=402653328
  &scope=bot%20applications.commands
```

That permission integer is Manage Roles + Manage Nicknames + Manage Channels + View Audit
Log. Invite it **only** to servers you intend to register — in production the bot audits,
alerts and then leaves anything not on the allowlist.

Then, in **Server Settings → Roles**, drag the bot's role **above every role it will
manage**, including every roster rank role. This is the single most common cause of
"it deployed fine and does nothing".

## 7. First run

1. Watch the `api` deploy log. The pre-deploy step should print the migrations it applied.
2. `curl https://<your-api-domain>/health` → `{"status":"ok"}`
3. `curl https://<your-api-domain>/health/ready` → both `database` and `redis` true. If
   `ready` is false but `health` is fine, the service is up but cannot reach a datastore —
   check the reference variables.
4. In Discord, register your commands. The bot registers guild-scoped commands on boot when
   `DEV_GUILD_IDS` is set; for production, run the global registration once:

   Railway → `bot` service → the **⋮** menu → **Run Command**:

   ```
   npm run commands:register
   ```

   Global commands can take up to an hour to appear. Guild-scoped are instant, so for
   testing set `DEV_GUILD_IDS=<your server id>` on the `bot` service first.

5. In your Discord server, run `/guild register` to put it on the allowlist. You can do
   this because your id is in `GLOBAL_ADMIN_DISCORD_IDS`; the bot reconciles that list into
   real permissions on every boot.
6. `/system health` should now report green.

## 8. Turn off dry run

Once you have run something real — `/roster sync dry_run:true`, or `/resync preview` — and
you agree with what it says it would do, set `SYNC_DRY_RUN_DEFAULT=false` on all three
services and redeploy.

---

## The website cookie problem

Railway gives you `something.up.railway.app`. Session cookies are `SameSite=Lax`, so they
are only sent when the API and the website are on the **same registrable domain**.
`floridarp.com` calling `flrp-api.up.railway.app` is cross-site: the browser silently drops
the cookie and every authenticated request 401s, with no CORS error to point at the cause.

The public roster endpoints (`/api/rosters`) work fine either way — they need no session.
The dashboard does not.

So before the dashboard goes live, add a custom domain: Railway → `api` → **Settings →
Networking → Custom Domain** → `api.floridarp.com`, then the CNAME it gives you at your DNS
provider. Update `DISCORD_OAUTH_REDIRECT_URI` and the Discord portal redirect to match.

Until then you can develop the frontend locally — `localhost:3000` to `localhost:4000` is
same-site for cookie purposes.

## Costs and sizing

Five services, but only three run continuously; Postgres and Redis are managed. The bot and
worker are near-idle between events. Railway bills by usage, so this sits at the low end
until the community is large.

Do not scale `worker` past one replica without thinking about it. It holds per-member locks
in Redis so multiple replicas are safe in principle, but the scheduled sweeps are written
assuming one runs at a time.

## Things that will bite you

| Symptom                                  | Cause                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Deploy healthcheck fails, no error       | The API is not on Railway's `PORT`. It reads `PORT` automatically — but only if you have not set `API_PORT` to something else. |
| Bot online, ignores role changes         | Server Members Intent not enabled in the Discord portal.                                                                       |
| Every write fails as a permission error  | Bot's role is below the roles it manages.                                                                                      |
| `/roster` renames nobody                 | Missing Manage Nicknames — re-invite with the permission integer above.                                                        |
| Dashboard 401s on every request          | Cross-site cookie. See above.                                                                                                  |
| Commands do not appear                   | Global registration takes up to an hour. Use `DEV_GUILD_IDS` while testing.                                                    |
| Boot fails: "SESSION_SECRET is required" | It is under 32 characters, or unset on `api`.                                                                                  |
| Migrations run three times               | The pre-deploy command is set on more than one service.                                                                        |
