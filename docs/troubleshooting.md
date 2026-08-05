# Troubleshooting

Start with `/system health` and `/audit failures`. Between them they explain most problems.

---

## Commands

### "This Discord server is not approved"

The guild is missing from the allowlist, or is disabled. A global administrator registers
it:

```
/guild register type:DEPARTMENT reason:onboarding
```

Check with `/guild list`. A guild that was removed shows as disabled rather than absent;
re-registering restores the original record along with its managed roles and history.

### The bot joins a new server and immediately leaves

That is auto-leave working as designed: the bot leaves any server that is not on the
approved allowlist. To onboard a new server, pause it first from an already-approved
server, then approve the new one, then turn it back on:

```
/guild autoleave enabled:false reason:onboarding
# ...invite the bot, then run /setup department or /guild register in the new server...
/guild autoleave enabled:true
```

Development mode (`DEV_MODE=true`, never in production) also keeps the bot in unapproved
servers.

### "Your Discord account is not linked to a platform account"

The Discord account has no member record. Somebody with `member.link` runs:

```
/member link member:@them reason:new community member
```

### Commands do not appear in Discord

- Global registration takes up to an hour. Use `npm run commands:register -- --guild` while
  developing.
- The bot must have been invited with the `applications.commands` scope. Re-inviting with
  the correct scope fixes it without kicking it.
- Check the bot is actually online: `/system health`, or the process logs.

### "You do not have the … permission"

The message names the capability. `/permissions view member:@them` shows what they hold and
in which scope. Common causes: the grant is guild-scoped and the action targets a different
guild, or their authority level is below the capability's minimum.

---

## Synchronization

### Nothing happens when I grant a role or change a mapping

Work through it in this order:

1. `/resync status job_id:<id>` — the job id is in the reply to the command. Was it created?
2. Is the **worker** running? The bot never writes roles itself. `/system health` shows
   queue depth; jobs piling up in `waiting` means no worker is consuming them.
3. Is `SYNC_DRY_RUN_DEFAULT=true`? Then every job plans and records without applying.
   Deliberate for a first deployment, confusing later.
4. Is `DISCORD_MOCK=true`? Writes are logged and skipped.
5. Is synchronization enabled for the guild? `/guild status`.
6. `/audit failures` — the answer is usually there with a specific reason.

### "That role sits above the bot's highest role"

The most common problem in a new deployment. In **Server Settings → Roles**, drag the bot's
role above every role it manages. Discord refuses to let a bot touch a role at or above its
own position.

`/guild status` lists every managed role currently above the bot.

### "The bot does not have permission to manage that role"

Either Manage Roles is missing in that server, or the role is owned by another integration
(a bot role, Server Booster, a subscriber role). Integration-owned roles cannot be assigned
by anybody — the platform refuses them at mapping time.

### Roles keep coming back after somebody removes them

Working as designed, and there are only two things that can cause it.

- **A mapping.** The member still holds the source role, and the mapping is authoritative,
  so the next reconciliation restores the target. Remove the source role, or change the
  mapping's authority.
- **A manual grant.** `/role grants member:@them` lists them. Revoke it with
  `/role revoke`; the role comes off on the next reconciliation.

If neither applies, the role is not the platform's — check `/role list` to confirm it has
no managed role definition at all.

### Roles keep disappearing after somebody adds them

The mirror image: an authoritative mapping with removal switched on computes the correct
value of that role as "absent". Either give the member the source role, add a manual grant
(if the role's purpose is `MANUAL_GRANT`), or switch the mapping's `syncRemove` off so the
platform stops treating the role as removable.

### A member is missing from a guild

Reported as a warning, not a failure. Their roles are applied in the guilds they _are_ in,
and nothing is retried against a guild they are not in.

### Two-way mapping seems one-way

Check the authority. `TWO_WAY` with `SOURCE_DISCORD` means the source wins and the target
is corrected to match — additions propagate both ways through events, but reconciliation
uses the authoritative side. For genuine union behaviour (additions propagate,
reconciliation never removes), use `MANUAL` authority.

### "This mapping would create a synchronization loop"

The error names the conflicting chain. Note that a _single_ two-way mapping is fine — what
is refused is a loop built from two or more mappings, for example `A → B` plus `B → A` as
separate one-way mappings. Use one two-way mapping instead.

### A job is stuck in PAUSED

It tripped the maximum-change threshold. `/resync status job_id:<id>` shows what it wanted
to do. Review the planned removals; if they are correct, either raise
`sync.maxRemovalsThreshold` or run the work in smaller pieces. Nothing was applied.

---

## Processes

### The bot starts and immediately exits

Read the first log line: environment validation failures are explicit about which variable
is wrong. The bot also refuses to start if the database is unreachable — an online bot that
rejects every command is worse than one that is visibly down.

### The worker starts but nothing is processed

- `REDIS_URL` must be identical for the bot, API and worker. A worker on a different Redis
  sees an empty queue while jobs accumulate elsewhere.
- Check for failed jobs: `/system health` reports the per-queue failed count.

### The API returns 401 to everything

- Is the session cookie being sent? Cross-origin requests need `credentials: 'include'`,
  and the dashboard origin must be in `CORS_ALLOWED_ORIGINS`.
- Unsafe methods need the `x-csrf-token` header echoing the `frm_csrf` cookie.
- `websiteAccess` must be true on the member's account.

### "CSRF token missing or invalid"

The `frm_csrf` cookie must be read and echoed in `x-csrf-token`. If the cookie is absent,
the session was created before the cookie was set — sign in again.

---

## Data

### Migration fails with a unique constraint violation

Existing data conflicts with a new constraint. Find the duplicates before retrying:

```sql
SELECT approved_guild_id, discord_role_id, count(*)
FROM managed_roles
WHERE deleted_at IS NULL
GROUP BY 1, 2 HAVING count(*) > 1;
```

### The enum parity test fails

An enum was changed in `prisma/schema.prisma` without updating
`packages/shared/src/enums.js`, or the reverse. Make them match — the test exists precisely
to catch this before it becomes a runtime bug in a role calculation.

### Integration tests fail with connection errors

They need PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
TEST_DATABASE_URL="postgresql://frm:frm_local_password@localhost:5432/frm_test?schema=public" \
  npx prisma migrate deploy
```

They skip themselves with a message when the services are unreachable; connection errors
mean something is half-up.

---

## Reading the logs

Every log line and every error response carries a `requestId`, and the same id is on the
audit record. To trace one action end to end:

```bash
docker compose logs | grep <requestId>
```

```sql
SELECT * FROM audit_logs WHERE request_id = '<requestId>';
```
