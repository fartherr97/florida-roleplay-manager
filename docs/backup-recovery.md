# Backup and recovery

## What is worth backing up

| Store           | Contains                                                | Losing it means                                                                                                      |
| --------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL**  | Everything: rosters, permissions, mappings, audit trail | Irrecoverable loss of community records                                                                              |
| **Redis**       | Queues, sync markers, locks, sessions                   | In-flight jobs and active sessions; no committed data                                                                |
| **Environment** | Secrets                                                 | Cannot start; the bot token can be reset, `SESSION_SECRET` cannot be recovered (rotating it just logs everybody out) |

Only PostgreSQL genuinely needs backing up. Redis is deliberately expendable: everything in
it is either reconstructible or short-lived.

## PostgreSQL backups

Nightly, retained for at least 30 days — long enough to notice that a roster was damaged
weeks ago.

```bash
pg_dump --format=custom --no-owner --file="frm-$(date +%F).dump" "$DATABASE_URL"
```

With Docker Compose:

```bash
docker compose exec -T postgres pg_dump -U frm --format=custom frm > "frm-$(date +%F).dump"
```

Restore:

```bash
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" frm-2026-01-15.dump
```

For point-in-time recovery, enable WAL archiving (`archive_mode=on`) or use a managed
service that does it for you. The audit trail is the one table where "restore to last
night" is genuinely lossy: it is the record of what happened, and a day of it cannot be
reconstructed from anywhere else.

**Test the restore.** A backup nobody has restored is a hypothesis. Restore into a scratch
database quarterly and check the row counts:

```sql
SELECT
  (SELECT count(*) FROM users)                  AS users,
  (SELECT count(*) FROM department_memberships) AS memberships,
  (SELECT count(*) FROM role_mappings)          AS mappings,
  (SELECT count(*) FROM audit_logs)             AS audit_records;
```

## Redis

No backup required. If persistence is enabled (`appendonly yes`, as in the compose file),
the AOF survives a restart, which avoids losing queued jobs on a planned deploy.

After an unplanned Redis loss:

- **Queued jobs are gone.** Anything committed to the database is still there; run
  `/resync all` (or wait for scheduled reconciliation) to reapply it.
- **Sync markers are gone.** For a few seconds the handler may treat one of its own changes
  as human and queue a redundant job. Reconciliation is idempotent, so this is noise, not
  damage.
- **Sessions are gone.** Everybody signs in again.

## Recovery scenarios

### Somebody ran a destructive resync

First: nothing has been lost that the audit trail cannot explain.

```sql
SELECT created_at, action, actor_discord_id, new_state
FROM audit_logs
WHERE action LIKE 'sync.%'
ORDER BY created_at DESC
LIMIT 20;

SELECT action, status, discord_user_id, discord_role_id, reason
FROM sync_actions
WHERE sync_job_id = '<job id>' AND action = 'REMOVE_ROLE';
```

If the roster is still correct, the fix is to run a normal resync: the engine restores
whatever the roster says people should have. Roles that were removed and are _not_ roster
derived have to be re-granted by hand — which is one reason the platform never removes
roles it cannot compute.

### The database was restored to an earlier point

Discord and the database are now out of step. Reconciliation is the repair tool:

1. Bring the worker up but leave the bot down, so no new events queue up.
2. `SYNC_DRY_RUN_DEFAULT=true`, then run a global resync and read the plan.
3. Check the removal count. A large one means the restore lost recent hires or promotions —
   fix the roster before applying anything.
4. Disable dry run, run the global resync, bring the bot back.

### A mapping caused chaos

```
/mapping disable mapping:<name> reason:investigating
/resync preview department:<affected>
```

Disabling stops further propagation immediately. The preview shows what the corrected state
looks like before you apply it.

### The bot token leaked

1. Reset it in the Discord developer portal — this immediately invalidates the old one.
2. Update `DISCORD_BOT_TOKEN` and restart the bot and worker.
3. Review `audit_logs` for the exposure window, particularly `guild.*`, `mapping.*` and
   `permission.*` actions.
4. `/audit recent failures_only:true` shows denied attempts.

## Retention

The audit trail is designed to be kept indefinitely — it is small (text and JSON, no blobs)
and it is the record of who did what. If you must prune, archive to cold storage rather than
deleting, and never grant the application role DELETE on `audit_logs`.

`SyncJob`, `SyncAction` and resolved `SyncIssue` rows are operational data and can be
pruned after a few months:

```sql
DELETE FROM sync_jobs
WHERE completed_at < now() - interval '90 days'
  AND status IN ('COMPLETED', 'CANCELLED');
```

`SyncAction` and `SyncIssue` cascade from `SyncJob`, so they go with it. Audit records
reference jobs with `ON DELETE RESTRICT`, so a job that an audit record points at cannot be
deleted — the trail cannot be orphaned by a cleanup script.
