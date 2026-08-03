# Database

PostgreSQL 16 via Prisma. Internal identifiers are UUIDs; Discord identifiers are
snowflakes stored as strings because they exceed `Number.MAX_SAFE_INTEGER`.

## Migrations

```bash
npm run prisma:migrate                 # development: create and apply a migration
npm run prisma:deploy                  # production: apply existing migrations only
npm run prisma:generate                # regenerate the client after a schema edit
npm run prisma:studio                  # browse the data
npm run prisma:reset                   # DESTRUCTIVE: drop, recreate, re-seed
```

Migrations are checked into `prisma/migrations/`. In production, `prisma migrate deploy`
runs as a one-shot step before the services start — the `migrate` service in
`docker-compose.yml` does exactly this, and every other service waits for it to succeed.

After changing an enum in `schema.prisma`, mirror it in `packages/shared/src/enums.js`.
`tests/unit/enum-parity.test.js` fails if the two drift apart, which is what makes the
duplication safe.

## Model map

**Identity**

| Model             | Purpose                                                 |
| ----------------- | ------------------------------------------------------- |
| `User`            | One row per person. Never one row per guild membership. |
| `DiscordIdentity` | Linked Discord accounts, unique on the snowflake        |

**Allowlist and structure**

| Model           | Purpose                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `ApprovedGuild` | The allowlist. Nothing works in a guild that is absent or disabled.                                    |
| `ManagedRole`   | A Discord role the platform is allowed to control. **Only roles with a row here can ever be removed.** |

**Grants**

| Model             | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `ManualRoleGrant` | Time-bounded manual authority; revoked or expired means the role comes off |

**Synchronization**

| Model         | Purpose                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `RoleMapping` | Cross-guild mappings with direction, authority, priority and add/remove switches |
| `SyncJob`     | One row per requested synchronization, with progress and status                  |
| `SyncAction`  | One row per planned or applied role change                                       |
| `SyncIssue`   | Unresolved failures, retryable individually                                      |

**Governance**

| Model                                    | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `PermissionCapability`                   | Catalogue, seeded from `packages/shared/src/capabilities.js` |
| `PermissionAssignment`                   | A capability granted in a scope, with an authority ceiling   |
| `PendingApproval`, `PendingApprovalVote` | Two-person rule for protected mappings                       |
| `AuditLog`                               | Append-only trail                                            |
| `SystemSetting`                          | Runtime-tunable settings such as the removal threshold       |

## Conventions worth knowing

**Soft deletion.** Records that carry history use `deletedAt`: `User`, `ApprovedGuild`,
`RoleMapping`, `ManagedRole`. Queries filter with the `notDeleted` helper.

**Restore rather than duplicate.** Natural-key uniqueness (one approved guild per Discord
guild, one mapping per role pair) is enforced with a plain unique constraint. Re-creating a
soft-deleted record restores the existing row, which keeps its managed roles, its history
and its audit trail attached instead of orphaning them.

**`scopeId` is `''`, not `NULL`, for global permission assignments.** PostgreSQL treats
NULLs as distinct inside a unique index, so a nullable scope would silently permit
duplicate global grants.

**`AuditLog` is append-only.** It has no `deletedAt` and no service method updates or
deletes it. To enforce that below the application, give the application role INSERT and
SELECT only:

```sql
REVOKE UPDATE, DELETE ON audit_logs FROM frm_app;
GRANT INSERT, SELECT ON audit_logs TO frm_app;
```

Run migrations as a separate, more privileged role.

**Indexes.** Every foreign key used in a filter is indexed, plus composite indexes for the
access patterns that actually happen: `(status, createdAt)` on jobs, `(resolved, createdAt)`
on issues, `(actorUserId, createdAt)`, `(targetUserId, createdAt)` and `(action, createdAt)`
on audit records, and `(sourceGuildId, sourceRoleId)` / `(targetGuildId, targetRoleId)` on
mappings, which is how the event handler decides whether a changed role matters.

## Seeding

```bash
npm run db:seed            # capabilities, system settings, bootstrap administrators
npm run db:seed -- --demo  # ...plus a demo community (refused in production)
```

The seed is idempotent — every write is an upsert, so it is safe to re-run after adding a
capability. Bootstrap administrators come from `GLOBAL_ADMIN_DISCORD_IDS`; without at least
one, nobody can administer the platform.
