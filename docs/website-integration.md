# Website integration

How the Florida Roleplay website talks to this platform.

This document is the contract. It is written to be handed to whoever is building the
website, in another repository, without them needing to read this codebase.

## The shape of it

The website is a **browser client**. It calls this API directly with a session cookie;
there is no server-to-server path and no API key. Everything the dashboard can do, it does
as a signed-in member, through the same services and the same authorization rules the
Discord commands go through.

```
Browser ──── cookie session ────► api.floridarp.com   (apps/api)
   │                                     │
   └── page load ──► floridarp.com       ├─► PostgreSQL
                     (the website)       └─► Redis (sessions, queue)
```

## The one thing that will break it

Session cookies are `httpOnly`, `signed`, and **`SameSite=Lax`**. A Lax cookie is not sent
on a cross-site request, so if the website and the API are on different registrable domains
the browser silently drops the cookie and **every authenticated request 401s** — with no
CORS error and nothing obviously wrong in the network tab.

So the API must be a **subdomain of the site's own domain**:

| Website             | API                 | Works                               |
| ------------------- | ------------------- | ----------------------------------- |
| `floridarp.com`     | `api.floridarp.com` | Yes                                 |
| `www.floridarp.com` | `api.floridarp.com` | Yes                                 |
| `floridarp.com`     | `flrp-api.fly.dev`  | **No** — cookie never sent          |
| `localhost:3000`    | `localhost:4000`    | Yes — same site for cookie purposes |

If the API genuinely has to live on a different domain, the cookie needs
`SameSite=None; Secure` — that is a one-line change in `apps/api/src/plugins/session.js`,
but it widens CSRF exposure and should be a deliberate decision, not a workaround.

## Authentication

Discord OAuth, `identify` scope only. The API never sees a Discord password and never
stores a Discord token.

```
1. Website sends the member to:      GET  https://api.floridarp.com/api/auth/discord
2. They approve on Discord, which returns to the API's callback.
3. API creates the session and sets two cookies, then redirects back to the site.
4. Website calls the API with `credentials: 'include'` from then on.
5. Sign out:                          POST https://api.floridarp.com/api/auth/logout
```

Two cookies are set:

| Cookie        | Readable by JS  | Purpose                                                                       |
| ------------- | --------------- | ----------------------------------------------------------------------------- |
| `frm_session` | No (`httpOnly`) | Opaque session id. The browser never receives anything else about the member. |
| `frm_csrf`    | **Yes**         | The CSRF token, to be echoed in a header.                                     |

### CSRF

Double-submit. Every **unsafe** request (`POST`, `PATCH`, `DELETE`) must echo the
`frm_csrf` cookie value in the `x-csrf-token` header. `GET`/`HEAD`/`OPTIONS` do not need
it. Missing or mismatched, the request is rejected as unauthenticated.

```js
const csrf = document.cookie
  .split('; ')
  .find((c) => c.startsWith('frm_csrf='))
  ?.split('=')[1];

await fetch('https://api.floridarp.com/api/rosters/manage', {
  method: 'POST',
  credentials: 'include', // required, or the session cookie is not sent
  headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
  body: JSON.stringify({ slug: 'staff', name: 'Staff Team', discordGuildId: '...' }),
});
```

### Who can sign in

Holding a Discord role mapped to an access tier (`/access grant`) grants website access,
and losing the role takes it away. This is the same rule that decides who can use the bot's
commands, so there is one place to manage staff access rather than two.

Access is a **persisted flag**, because the API process has no Discord gateway and cannot
read anybody's roles at sign-in. It is kept in step at three points: whenever the member
runs a bot command, immediately when a tier-mapped role changes hands, and by a scheduled
sweep that recomputes the whole main guild. Access granted by hand on an account with no
tier is never revoked by the sweep.

A member with no tier and no explicit grant gets `401` with
`"Your account does not have website access."` — that is the expected response for a
non-staff visitor, not a bug.

## Endpoints

All under `/api`. Every one below requires a session except where marked **public**.

### Rosters

| Method                                   | Path                                           | Notes                                                      |
| ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| GET                                      | `/rosters`                                     | **Public.** Every published roster. ETagged, `max-age=60`. |
| GET                                      | `/rosters/:slug`                               | **Public.** One roster.                                    |
| GET                                      | `/rosters/manage`                              | All rosters including unpublished.                         |
| POST                                     | `/rosters/manage`                              | Create.                                                    |
| GET&nbsp;/&nbsp;PATCH&nbsp;/&nbsp;DELETE | `/rosters/manage/:slug`                        | Read, edit, retire.                                        |
| POST                                     | `/rosters/manage/:slug/ranks`                  | Bind a Discord role to a rank.                             |
| DELETE                                   | `/rosters/manage/:slug/ranks/:roleId`          | Unbind.                                                    |
| PATCH                                    | `/rosters/manage/:slug/members/:discordUserId` | Callsign and name override.                                |
| POST                                     | `/rosters/manage/:slug/sync`                   | Reconcile now. Takes `dryRun`.                             |

The public read model is documented in [rosters.md](rosters.md). It is the endpoint the
staff pages should render from — it is cached, contains no internal identifiers, and needs
no session.

### Discord roles

| Method | Path                             | Notes                                                                      |
| ------ | -------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/guilds/:guildId/discord-roles` | The guild's Discord roles, highest first. `?refresh=true` skips the cache. |

The API has no gateway connection, so this is a read-through to Discord's REST API with the
bot token, cached for a minute. It is a read, so it does not disturb the rule that the
worker is the only process that writes to Discord.

`:guildId` is the platform's `ApprovedGuild` id. It is resolved and scope-checked before
any snowflake reaches Discord — passing a caller-supplied Discord id would let anybody
enumerate the roles of any server the bot happens to be in.

Each role carries `assignable`: false when the role outranks the bot, or when an
integration owns it. Binding a non-assignable role yields a configuration that looks right
and does nothing, so a picker should surface it rather than let it be chosen silently.

Needs `DISCORD_BOT_TOKEN` on the API deployment. Without it the API still boots and serves
everything else — this endpoint alone returns a `PRECONDITION_FAILED` naming the variable.

### Access tiers

| Method | Path                     | Notes                                              |
| ------ | ------------------------ | -------------------------------------------------- |
| GET    | `/access`                | Role → tier rules, highest first.                  |
| POST   | `/access`                | Map a role to a tier (`access.manage` capability). |
| DELETE | `/access/:discordRoleId` | Remove the mapping. The Discord role is untouched. |

The same rules `/access` manages from Discord. Deliberately available in both places:
mapping a role to a tier is what grants website access, so managing it _only_ on the
website would mean a misconfiguration could lock everybody out of the tool needed to fix
it. `GLOBAL_ADMIN_DISCORD_IDS` is the other half of that guarantee — those accounts are
granted access on every boot regardless of tier.

### Permissions and access

| Method | Path                         | Notes                                                                                              |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/permissions`               | Assignments, filterable.                                                                           |
| GET    | `/permissions/capabilities`  | The capability catalogue — use it to build the UI rather than hard-coding capability keys.         |
| POST   | `/permissions`               | Grant a capability.                                                                                |
| DELETE | `/permissions/:assignmentId` | Revoke.                                                                                            |
| GET    | `/me`                        | The signed-in member, their level and their effective capabilities. Drive UI visibility from this. |

### Guilds, roles, grants, mappings

| Method         | Path                                                  |
| -------------- | ----------------------------------------------------- |
| GET / POST     | `/guilds`                                             |
| GET            | `/guilds/:guildId/status`                             |
| PATCH / DELETE | `/guilds/:guildId`                                    |
| GET / POST     | `/roles` · DELETE `/roles/:managedRoleId`             |
| GET / POST     | `/grants` · DELETE `/grants/:grantId`                 |
| GET / POST     | `/mappings` · GET/PATCH/DELETE `/mappings/:mappingId` |
| POST           | `/mappings/:mappingId/enabled` · `/test`              |

### Members, sync, audit, health

| Method | Path                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| GET    | `/members` · `/members/lookup` · `/members/:userId` · `/members/:userId/audit` |
| GET    | `/sync/jobs` · `/sync/jobs/:jobId` · `/sync/issues`                            |
| POST   | `/sync/member` · `/sync/guild` · `/sync/all` · `/sync/jobs/:jobId/cancel`      |
| POST   | `/sync/issues/:issueId/retry` · `/resolve`                                     |
| GET    | `/audit` · `/audit/export`                                                     |
| GET    | `/system/health`                                                               |
| GET    | `/health`, `/health/ready`                                                     | **Public**, outside `/api`. For load balancers. |

## Response shapes

Success is the resource, or a page:

```jsonc
{
  "items": [...],
  "pagination": { "page": 1, "pageSize": 25, "total": 91, "totalPages": 4, "hasNext": true }
}
```

Errors are always this shape, and never contain a stack trace or an internal message:

```jsonc
{
  "error": { "code": "AUTHORIZATION_DENIED", "message": "Written for a human to read." },
  "requestId": "01J...",
}
```

| Status | Means                                                              |
| ------ | ------------------------------------------------------------------ |
| 400    | Validation failed. `message` is safe to show the user.             |
| 401    | Not signed in, session expired, no website access, or CSRF failed. |
| 403    | Signed in but not permitted.                                       |
| 404    | Not found — or not visible to this member.                         |
| 409    | Conflict (duplicate slug, callsign already held).                  |
| 429    | Rate limited.                                                      |

Show `message` to the user and log `requestId`; it matches the audit trail, so a support
question can be answered exactly.

## Configuration

Set on the **API** deployment:

```bash
CORS_ALLOWED_ORIGINS=https://floridarp.com,https://www.floridarp.com
DISCORD_OAUTH_REDIRECT_URI=https://api.floridarp.com/api/auth/discord/callback
COOKIE_SECURE=true
API_TRUST_PROXY=true          # when behind a proxy, so rate limiting sees real IPs
SESSION_SECRET=<32+ random chars>
SESSION_TTL_SECONDS=86400
DISCORD_BOT_TOKEN=<bot token> # optional: only the Discord role picker needs it
```

`CORS_ALLOWED_ORIGINS` is an exact-match allowlist, not a pattern — credentials and `*` are
mutually exclusive, so every origin the site is served from must be listed, including
`www`. The same redirect URI must be registered in the Discord developer portal under
**OAuth2 → Redirects**, character for character.

Locally: `CORS_ALLOWED_ORIGINS=http://localhost:3000`, `COOKIE_SECURE=false`, and register
`http://localhost:4000/api/auth/discord/callback` as a second redirect in the portal.

## Things worth knowing before you build against it

- **Authorization is enforced server side, always.** `/me` tells you what to show, never
  what to allow. Every service call re-checks.
- **The actor is re-loaded on every request.** Revoking a permission takes effect on the
  next request, not when the session expires.
- **Identifiers are resolved server side.** No endpoint takes a caller-supplied scope; you
  pass the id of the thing, and the API decides whether this member may touch it.
- **Writes are queued, not immediate.** Anything that changes Discord returns a job id.
  Poll `/sync/jobs/:jobId` for the outcome rather than assuming success.
- **The bot never calls the website.** Traffic is one-way. If the site needs to react to
  something, it polls.
