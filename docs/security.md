# Security

## The threat this system is actually built against

A community-wide role platform installed in several Discord servers has one dominant risk:
somebody obtains the ability to change roles they should not control — either by attaching
an unrelated server to the role graph, or by escalating within the permission system.
Almost every control below exists for one of those two reasons.

## Guild allowlist

Nothing works in a Discord server that is not registered and enabled:

- every slash command is refused before it runs;
- both sides of every mapping are re-checked at creation, at enable, and again at apply
  time — the allowlist can change between planning and execution;
- the bot audits, alerts and then leaves servers it is added to without approval
  (production always leaves; `DEV_MODE` can suppress it outside production).

Registration requires the global `guild.register` capability. Discord's own Administrator
permission is deliberately not sufficient: the owner of an unrelated server has
Administrator in their own guild, and that must not be a path in.

## Authorization

Every action is authorized in the backend, from both boundaries, with the same code. Slash
command visibility is not a control — Discord delivers the interaction regardless of what
the client rendered.

An actor is allowed only when all of these hold:

1. their account is active;
2. they hold the capability;
3. an assignment's scope covers the resolved resource;
4. their authority level meets the capability's minimum;
5. the target's authority level is within the assignment's ceiling;
6. the target's authority level is strictly below the actor's own;
7. the action is not self-directed.

Granting is bounded the same way: you cannot grant a capability you do not hold, in a scope
wider than yours, or with an authority ceiling at or above your own level. An actor whose
own grant is bounded cannot issue an unbounded one.

Reading your own record is exempt — a member with no grants can still see their own
profile — but every _change_ goes through the full check.

## Preventing IDOR

Identifiers from a slash command or an HTTP body are never treated as authority. Each one
is resolved to a real row, and the row's own guild is what the authorization check runs
against. A caller can send any guild id, managed role id or mapping id they like; what they
get back is a 403 unless their assignment covers _that_ guild.

Related: sort fields are validated against an allowlist, so a client cannot order by (and
thereby infer) a column it is not permitted to read, and page sizes are capped server side.

## Ordering: authorize before you explain

Domain validation runs _after_ authorization. An actor with no access to a guild is told
they lack permission — not that "that role is managed by another integration", which would
leak the guild's role configuration.

## Mass-change protection

- **Maximum-change threshold.** A job planning more removals than the configured limit
  pauses, records what it intended to do, raises a critical issue and alerts
  administrators. Nothing is applied.
- **Previews and confirmation.** Guild and global resyncs run a dry run first and show real
  numbers before asking.
- **Removal is restricted to computable roles.** The engine removes only roles whose
  correct value it can derive — from a manual grant, or from an authoritative mapping with
  removal switched on. A member's own community roles are never touched, and a Discord
  account with no platform record has only its mapped roles managed.

## Protected roles

Roles can be marked `ELEVATED` (mapping them requires the `mapping.approve` capability) or
`TWO_PERSON` (a second, _different_ authorized administrator must sign off before the
mapping can be enabled). The requester cannot approve their own request; that is the entire
point of the control and it is enforced in `approval-service.js` and tested directly.

Integration-owned roles (bot roles, boosters, subscriber roles) and `@everyone` are refused
outright at every level.

## Secrets

- Only in environment variables. Never in the database, a response, or a commit.
- Validated at startup; missing or weak required secrets abort the process. In production
  the example `SESSION_SECRET` placeholder is rejected and `COOKIE_SECURE` must be true.
- The bot token exists only in the bot and worker environments. The API — the
  internet-facing process — never receives it.
- The logger redacts tokens, secrets, connection strings, webhook URLs, `authorization` and
  `cookie` headers, and any `token`/`password`/`secret` field at any depth.

## Web boundary

| Control                 | Implementation                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions                | Opaque random id in a signed, httpOnly, SameSite=Lax cookie; state in Redis with a TTL. The browser learns nothing about the member from the cookie. |
| Authorization freshness | The actor is re-loaded from the database on every request, so a revoked permission takes effect immediately rather than at session expiry.           |
| CSRF                    | Double-submit: a token in the session, mirrored in a readable cookie, required in `x-csrf-token` on every unsafe method. Compared in constant time.  |
| Login CSRF              | OAuth `state` is server-side, single use and expiring.                                                                                               |
| CORS                    | Explicit origin allowlist; wildcards are impossible with credentials.                                                                                |
| Headers                 | Helmet, with HSTS in production.                                                                                                                     |
| Rate limiting           | Per session, falling back to IP. Discord commands are separately limited per user in Redis.                                                          |
| Error responses         | Stack traces and internal messages never leave the process. Clients get a stable code, a safe message and a correlation id.                          |
| Input                   | Zod at the boundary and again inside the service.                                                                                                    |
| SQL injection           | Prisma parameterized queries throughout. The one raw statement is a fixed `TRUNCATE` in the test helper, with no interpolated input.                 |

## Audit trail

Every significant action writes an immutable record: actor (platform and Discord id),
action, source (Discord / website / system / scheduled), target, guild, mapping, sync job,
before and after state, reason, request id, IP address for website actions, success or
failure, and error details.

Denied actions are audited too — a trail of only successes cannot answer "who keeps trying
to grant themselves permissions?".

No service method updates or deletes an audit row. Enforce it in the database as well:

```sql
REVOKE UPDATE, DELETE ON audit_logs FROM frm_app;
GRANT INSERT, SELECT ON audit_logs TO frm_app;
```

## Discord-specific

- **Interaction options are user input.** Every snowflake is validated, mention wrappers are
  stripped, and every id is re-resolved server side.
- **Role hierarchy is checked before every write**: bot present, guild available, member
  present, role exists, not `@everyone`, not integration-owned, bot has Manage Roles, bot's
  highest role is above the target, protection policy satisfied.
- **The audit-log lookup used to attribute manual changes is best effort.** It needs View
  Audit Log and can lag; a null result changes nothing about how the event is processed.

## Residual risks

Worth knowing rather than hiding:

- **A compromised bot token is total compromise** of every server the bot is in. Rotate it
  if there is any doubt; nothing in this platform can compensate for it.
- **A global administrator can do anything.** Keep the list short, and remember that
  `GLOBAL_ADMIN_DISCORD_IDS` grants `system.manage` on the next seed run.
- **Redis loss degrades loop protection.** The handler fails safe by ignoring role events
  rather than risking a propagation loop, so drift accumulates until Redis returns.
  Scheduled reconciliation repairs it.
- **Threshold tuning is a judgement call.** Too high and a bad mapping can do real damage
  before anybody notices; too low and routine work keeps pausing.
- **This code has not been run against a live Discord server.** The whole Discord surface
  is exercised through a mock. Start with `DISCORD_MOCK=true` and dry run enabled.

## Reporting

Report suspected vulnerabilities privately to the community's technical leadership. Do not
open a public issue containing a token, a session id or a working exploit.
