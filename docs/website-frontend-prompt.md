# Handoff: building the Florida Roleplay dashboard

Paste everything below the line into the session that is building the website. It is
self-contained — that session cannot see the bot's repository, so nothing here refers to a
file it would have to open.

---

## What I'm building

A dashboard on the Florida Roleplay website for managing our Discord bot: staff
permissions, server setup and configuration, and the staff rosters.

The bot is a separate service that already exists and is already deployed. It exposes a
REST API. **This project is a frontend only** — it does not talk to the database, and it
does not reimplement any authorization. Every rule is enforced server side by the API;
the dashboard's job is to present it well.

Do not build a backend for this. Do not add a database. If something seems to need one,
say so and stop rather than working around it.

## How authentication works

Discord OAuth, handled entirely by the API. The dashboard never sees a token.

1. Send the member to `GET {API}/api/auth/discord`. This is a full page navigation, not a
   fetch — it redirects to Discord.
2. They approve. Discord returns them to the API's callback, which creates a session and
   redirects back to the site.
3. From then on, every request carries a session cookie automatically.
4. Sign out with `POST {API}/api/auth/logout`.

Two cookies are set by the API:

| Cookie        | Readable by JS | What it is                       |
| ------------- | -------------- | -------------------------------- |
| `frm_session` | No (httpOnly)  | An opaque session id.            |
| `frm_csrf`    | **Yes**        | A CSRF token you must echo back. |

**Every request needs `credentials: 'include'`.** Without it the browser does not send the
session cookie and everything 401s.

**Every POST, PATCH and DELETE needs the CSRF token** from the `frm_csrf` cookie, sent in
an `x-csrf-token` header. GET does not.

### Who can sign in

Only staff. Access is granted by holding a Discord role that an administrator has mapped
to an access tier — the same roles that grant bot access. A non-staff member who signs in
successfully with Discord still gets `401` with _"Your account does not have website
access."_ That is correct behaviour, not a bug: show them a clear "you're not staff" page,
not an error.

## The API client

Use this. It handles the parts that are easy to get subtly wrong.

```js
// api.js
const BASE = import.meta.env.VITE_API_URL; // e.g. https://api.floridarp.com

/** The CSRF token the API set, or null when signed out. */
function csrfToken() {
  return (
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('frm_csrf='))
      ?.split('=')[1] ?? null
  );
}

export class ApiError extends Error {
  constructor({ status, code, message, requestId }) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
  get isUnauthenticated() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';

  // Unsafe methods must echo the CSRF cookie back in a header. The API rejects them
  // outright otherwise, and the failure looks like an auth error rather than a CSRF one.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    credentials: 'include', // required: this is what sends the session cookie
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: payload?.error?.code ?? 'UNKNOWN',
      message: payload?.error?.message ?? 'Something went wrong.',
      requestId: payload?.requestId,
    });
  }

  return payload;
}

/**
 * Anything that changes Discord is queued, so the response is a job id rather than a
 * result. Poll until it finishes instead of assuming it worked.
 */
export async function waitForJob(jobId, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const terminal = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'PAUSED'];

  while (Date.now() < deadline) {
    const job = await api(`/sync/jobs/${jobId}`);
    if (terminal.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for the job to finish');
}
```

## Endpoints

Everything is under `{API}/api`. All require a session except the two marked public.

### Rosters — published staff lists

| Method               | Path                                           | Notes                                                   |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| GET                  | `/rosters`                                     | **Public.** All published rosters. Cached, ETagged.     |
| GET                  | `/rosters/:slug`                               | **Public.** One roster.                                 |
| GET                  | `/rosters/manage`                              | All rosters, including unpublished.                     |
| POST                 | `/rosters/manage`                              | `{slug, name, description?, discordGuildId, position?}` |
| GET / PATCH / DELETE | `/rosters/manage/:slug`                        | Read, edit, retire.                                     |
| POST                 | `/rosters/manage/:slug/ranks`                  | `{discordRoleId, name, shortName?, position}`           |
| DELETE               | `/rosters/manage/:slug/ranks/:roleId`          | Unbind a rank.                                          |
| PATCH                | `/rosters/manage/:slug/members/:discordUserId` | `{callsign?, preferredName?}` — send `null` to clear.   |
| POST                 | `/rosters/manage/:slug/sync`                   | `{dryRun?}` → returns a job id.                         |

The **public** roster pages should render from `GET /rosters` — it is cached, needs no
session, and contains no internal identifiers. Shape:

```jsonc
{
  "rosters": [
    {
      "slug": "staff",
      "name": "Staff Team",
      "description": null,
      "position": 0,
      "updatedAt": "2026-08-23T19:00:00.000Z",
      "ranks": [
        {
          "name": "Senior Administrator",
          "shortName": "Sr. Admin",
          "position": 30,
          "discordRoleId": "940000000000000003",
          "members": [
            {
              "discordUserId": "930000000000000002",
              "name": "Mike",
              "callsign": "165",
              "since": "2026-08-01T12:00:00.000Z",
            },
          ],
        },
      ],
    },
  ],
}
```

Ranks come back highest-seniority first; members are sorted by callsign then name. Render
in the order given — do not re-sort.

**Rosters are computed from Discord roles.** There is no endpoint to add somebody to a
roster, and there should be no UI implying there is. People join by being given the Discord
role. The editable fields are the roster's own settings, its rank bindings, and each
member's callsign and displayed name.

### Discord roles — the role picker

| Method | Path                             | Notes                                                           |
| ------ | -------------------------------- | --------------------------------------------------------------- |
| GET    | `/guilds/:guildId/discord-roles` | The guild's Discord roles. `?refresh=true` to bypass the cache. |

Anywhere the UI asks for a Discord role — roster ranks, access tiers, managed roles,
mappings — drive it from this. Never make the user paste a snowflake.

`:guildId` is the **platform's** guild id from `GET /guilds`, not the Discord snowflake.
The API resolves it and checks your scope before it calls Discord, so you cannot use this
to read a server you have no access to.

```jsonc
{
  "guildId": "01J...",
  "discordGuildId": "900000000000000001",
  "botHighestPosition": 20,
  "cachedAt": "2026-08-25T21:00:00.000Z",
  "roles": [
    {
      "id": "904",
      "name": "Owner",
      "position": 40,
      "color": 0,
      "hoist": true,
      "mentionable": false,
      "managed": false,
      "assignable": false,
    },
    {
      "id": "902",
      "name": "Administrator",
      "position": 10,
      "color": 15158332,
      "hoist": true,
      "mentionable": false,
      "managed": false,
      "assignable": true,
    },
  ],
}
```

Sorted highest-first; render in the order given.

**`assignable` is the field that matters.** It is false when the role sits above the bot's
own highest role, or when Discord owns it (another bot's integration role). Binding a
non-assignable role produces a configuration that looks correct and silently does nothing —
so show those greyed out with an explanation ("the bot's role must be above this one in
Server Settings → Roles") rather than hiding them, which would just make the role look
missing.

`botHighestPosition: 0` means the API could not read the bot's own membership, so
assignability is unknown and everything comes back `false`. Worth saying so rather than
telling the user nothing can be assigned.

Cached about a minute server side. Pass `?refresh=true` behind an explicit "refresh"
control after somebody has just made a role in Discord.

A `409`-style `PRECONDITION_FAILED` here means the API has no bot token configured. Show
the message; it names the variable.

### Access tiers — who is staff

| Method | Path                     | Notes                                       |
| ------ | ------------------------ | ------------------------------------------- |
| GET    | `/access`                | The role → tier rules, highest tier first.  |
| POST   | `/access`                | `{discordRoleId, roleName, level, reason?}` |
| DELETE | `/access/:discordRoleId` | Remove a rule.                              |

This is the important one to understand: **holding a mapped Discord role is what grants
website access**, and the same rule grants bot access. There is no separate user list and
no invite flow. Somebody becomes staff by getting the role in Discord.

`level` is one of `20` Supervisor, `40` Command, `60` Manager, `80` Staff, `100` Admin.
Holders get every capability up to their tier. Use `GET /permissions/capabilities` for
labels rather than hard-coding these.

Two things to build in deliberately:

- **Warn before removing a rule.** Revoking the tier that the signed-in user holds is how
  somebody locks themselves out of the dashboard. It is recoverable — the same mapping can
  be set from Discord with `/access grant` — but say so before they click, not after.
- Requires the `access.manage` capability, which in practice means a global admin. Expect
  `403` for everybody else and hide the screen.

### Permissions and the current user

| Method | Path                         | Notes                                                    |
| ------ | ---------------------------- | -------------------------------------------------------- |
| GET    | `/me`                        | `{user, grants, permissions, capabilities}` — see below. |
| GET    | `/permissions`               | Assignments, paginated.                                  |
| GET    | `/permissions/capabilities`  | The capability catalogue.                                |
| POST   | `/permissions`               | Grant a capability.                                      |
| DELETE | `/permissions/:assignmentId` | Revoke.                                                  |

**Build the permissions UI from `GET /permissions/capabilities`, not a hard-coded list.**
It returns each capability's key, category, description, allowed scopes, whether it is
dangerous, and the minimum authority level. Group by `category`, use `description` as the
label text, and flag `dangerous: true` ones in the UI. Hard-coding the list means it drifts
the moment the bot adds a capability.

`GET /me` returns the signed-in member plus a `capabilities` array of
`{capability, scopeType, scopeId, maxPermissionLevel}`. Use it to decide what to _show_.
**Never use it to decide what to allow** — the API re-checks every call, and a dashboard
that hides a button has not prevented anything.

### Server configuration

| Method         | Path                                                         |
| -------------- | ------------------------------------------------------------ |
| GET / POST     | `/guilds`                                                    |
| GET            | `/guilds/:guildId/status`                                    |
| PATCH / DELETE | `/guilds/:guildId`                                           |
| GET / POST     | `/roles` · DELETE `/roles/:managedRoleId`                    |
| GET / POST     | `/grants` · DELETE `/grants/:grantId`                        |
| GET / POST     | `/mappings` · GET / PATCH / DELETE `/mappings/:mappingId`    |
| POST           | `/mappings/:mappingId/enabled` · `/mappings/:mappingId/test` |

`/mappings/:mappingId/test` previews what a mapping would do without applying it. Surface
it prominently — it is the safe way to check a rule before turning it on.

### Members, sync, audit

| Method | Path                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| GET    | `/members` · `/members/lookup` · `/members/:userId` · `/members/:userId/audit`               |
| GET    | `/sync/jobs` · `/sync/jobs/:jobId` · `/sync/issues`                                          |
| POST   | `/sync/member` · `/sync/guild` · `/sync/all`                                                 |
| POST   | `/sync/jobs/:jobId/cancel` · `/sync/issues/:issueId/retry` · `/sync/issues/:issueId/resolve` |
| GET    | `/audit` · `/audit/export`                                                                   |
| GET    | `/system/health`                                                                             |

`/sync/issues` is worth a real screen rather than a buried table: it is where the bot
reports what it could not do — a member it cannot rename, a role above the bot, a deleted
role. Each issue has a type, severity, message and whether it is retryable.

## Responses

Lists are paginated:

```jsonc
{
  "items": [],
  "pagination": { "page": 1, "pageSize": 25, "total": 91, "totalPages": 4, "hasNext": true },
}
```

Send `?page=&pageSize=&sortDir=` — `pageSize` is capped server side, and sorting is limited
to an allowlist of fields per endpoint. An unrecognised sort field is a `400`, not a
silently ignored parameter.

Errors are always this shape:

```jsonc
{
  "error": { "code": "AUTHORIZATION_DENIED", "message": "Written for a human to read." },
  "requestId": "01J...",
}
```

| Status | Meaning                                                | What the UI should do                                                                            |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 400    | Validation failed                                      | Show `message` — it is written for the user.                                                     |
| 401    | Signed out, expired, no website access, or CSRF failed | Send them to sign in. If the message mentions website access, show the "not staff" page instead. |
| 403    | Signed in, not permitted                               | Explain; do not offer a retry.                                                                   |
| 404    | Not found, or not visible to them                      |                                                                                                  |
| 409    | Conflict — duplicate slug, callsign already taken      | Show `message`; it names the conflict.                                                           |
| 429    | Rate limited                                           | Back off; do not retry in a tight loop.                                                          |

`message` is always safe to display — the API never leaks internal detail into it. Log
`requestId` and show it on error screens: it matches the bot's audit trail, so a support
question can be answered exactly.

## Configuration

```bash
VITE_API_URL=https://api.floridarp.com
```

Local development points at `http://localhost:4000`.

**The API must be on a subdomain of the site's own domain** — `api.floridarp.com` with
`floridarp.com`. Session cookies are `SameSite=Lax`, so on any other domain the browser
silently drops the cookie and every request 401s, with no CORS error and nothing obviously
wrong in the network tab. If the deployment cannot do that, stop and tell me rather than
working around it.

## Design notes

- Writes are **asynchronous**. Anything touching Discord returns a job id; poll it. Show
  the job's real outcome, not an optimistic success toast.
- A job can come back `PAUSED`. That is a safety guard tripping — usually a change that
  would have removed a lot of people at once — not a failure. Say so, and show what it
  would have done.
- Prefer showing the API's `message` over inventing your own copy. It was written for this.
- Nothing here needs realtime. Polling on an open screen is fine; there is no websocket.

## What to build first

1. Sign in, sign out, and the "you're not staff" state. Nothing else works until this does.
2. The public roster pages — no auth, cached endpoint, immediately useful.
3. The roster management screens — these need the role picker
   (`/guilds/:guildId/discord-roles`), so build that as a shared component first.
4. Access tiers, then permissions driven off the capability catalogue.
5. Sync issues and audit.

Ask me before designing anything that implies a capability the API does not have. If an
endpoint you need seems to be missing, say so — I can add it on the bot side.
