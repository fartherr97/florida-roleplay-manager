# Architecture

## The shape of the system

Three processes share one library. The library holds every rule; the processes only
translate between their own input format and a service call.

```
                     ┌──────────────────────────────┐
   Discord ──────────►  apps/bot                    │  events + slash commands
                     │  (no role writes)            │
                     └──────────────┬───────────────┘
                                    │
   Dashboard ────────►  apps/api ───┤   packages/core   ──►  PostgreSQL
   (future Next.js)   (no bot token)│  (all the rules)
                                    │
                     ┌──────────────┴───────────────┐
                     │  apps/worker                 │  the only role writer
                     │  (queue + scheduled sweeps)  │
                     └──────────────┬───────────────┘
                                    └──────────────────►  Discord
```

Why the bot does not write roles: Discord gives an interaction three seconds to be
acknowledged. A department resync touching four hundred members cannot happen inside that
budget, and an interaction handler that blocks on it produces "the application did not
respond" while still half-applying changes. The bot creates a job; the worker does the
work; the bot reports on it.

Why the API has no bot token: it does not need one. It writes to the database and queues
jobs. Keeping the token out of the internet-facing process removes an entire class of
compromise.

## Package dependency graph

Acyclic, and enforced: `import/no-cycle` is an ESLint error and
`tests/unit/enum-parity.test.js` guards the one deliberate piece of duplication.

```
shared ──► logging ──► validation
   │          │
   │          ▼
   ├──────► database ──► authorization
   │          │
   ├──────► discord ────► reconciliation
   │                          ▲
   └──────► queue ────────────┘
                │
                ▼
              core ──► apps/{bot,api,worker}
```

`packages/reconciliation` depends on the _interface_ of a role gateway, never on
discord.js. That is what lets the entire synchronization path be tested offline.

## Request lifecycle

Every mutation follows the same seven steps, whether it arrives from a slash command or an
HTTP request:

1. **Validate** the input with Zod — again, server side, regardless of what the caller
   claims to have validated.
2. **Resolve** every identifier to a real row. A caller-supplied department id is never
   treated as a scope; it is looked up, and the row's own identity is what gets authorized.
3. **Authorize**: capability, scope, rank ceiling, authority ceiling, self-management rule.
4. **Check domain preconditions** — a promotion must go up, a suspended member cannot be
   suspended again. This runs _after_ authorization so that an unauthorized caller learns
   nothing about the data.
5. **Write** the row change, the membership event, the audit record and the sync job in a
   single transaction.
6. **Enqueue** after the commit. A queue is not transactional; a job that ran before its
   data was visible would reconcile against stale state.
7. **Report** partial or full failure honestly, including when the enqueue itself failed.

## The reconciliation engine

```
desired state  −  actual state  =  required changes
```

**Desired state** is computed from roster data (memberships, ranks, supervisor/command
flags, certifications, subdivisions, LOA/suspension status), manual time-bounded grants,
and enabled mappings.

**Controlled state** is the set of roles the platform is allowed to _remove_. This is the
important half. A role is controlled only when the engine can compute its correct value:

- a managed role whose purpose is roster-driven (membership, rank, supervisor, command,
  certification, subdivision, status), or
- a managed role granted by an explicit manual grant, or
- the target of an enabled, authoritative mapping with removal sync switched on.

Everything else is left alone forever. A community member's cosmetic, notification and
interest roles are not the platform's business, and a role of purpose `OTHER` is
deliberately never removable.

**Authority rules** for mappings:

| Direction | Authority       | Behaviour                                             |
| --------- | --------------- | ----------------------------------------------------- |
| ONE_WAY   | SOURCE_DISCORD  | target mirrors the source                             |
| ONE_WAY   | TARGET_DISCORD  | source mirrors the target                             |
| ONE_WAY   | ROSTER          | target mirrors the roster-derived value of the source |
| TWO_WAY   | SOURCE_DISCORD  | source wins; the target is corrected to match         |
| TWO_WAY   | TARGET_DISCORD  | target wins; the source is corrected to match         |
| TWO_WAY   | MANUAL / SYSTEM | union for additions; reconciliation never removes     |

The union rule for authority-less two-way mappings exists because "both sides are equal"
has no deterministic answer when they disagree. Picking one arbitrarily would make the
reconciler flip the state back and forth on every run. Under union, additions converge and
removals propagate through the event handler, which knows which side actually changed.

Mapping chains settle in a single pass because each pass reads the _effective_ state
produced by the previous one, rather than raw Discord state.

## Loop protection

The failure mode: the bot applies a mapped role, Discord emits the event, the handler
treats it as a human action and propagates it back, forever.

Before every role write the worker stores a marker in Redis keyed by
`(guild, member, role, action)` with a TTL. When the resulting event arrives, the handler
_claims_ the marker with an atomic Lua get-and-delete and stops.

Two properties matter, and both are tested:

- **Redis, not an in-process Set.** The process that applies a change is usually not the
  process that receives the event, and either may be one of several replicas.
- **Single use.** GET followed by DEL as two commands would let two concurrent events both
  claim the same marker. The script makes claiming atomic.

If a Discord call fails, its marker is deleted immediately — otherwise it would swallow the
next genuine event for that role.

Loops are also prevented structurally: a mapping that would close a cycle is rejected when
it is created or enabled. A single two-way mapping is _not_ a cycle (it is the feature);
only loops built from two or more distinct mappings are refused.

## Concurrency and failure

| Situation                              | Handling                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Two jobs for the same member           | Redis mutex per member; the loser skips, because reconciliation is idempotent |
| Marker expires before the event        | One redundant, idempotent job; TTL is configurable                            |
| Commit succeeds, enqueue fails         | `SyncIssue` recorded; scheduled reconciliation repairs it                     |
| Role deleted mid-job                   | Pre-flight re-checks per action; typed `ROLE_DELETED` issue                   |
| Discord rate limit                     | Marked retryable; BullMQ exponential backoff                                  |
| Missing permission                     | Marked permanent; the job is discarded rather than retried five times         |
| Guild de-listed between plan and apply | Re-checked at apply time; the action is skipped                               |

## Safety rails

- **Maximum-change threshold.** A job that would remove more roles than the configured
  limit pauses, records the planned actions, raises a critical issue and alerts
  administrators. Nothing is applied.
- **Previews.** Department, guild and global resyncs run a dry run first and show the real
  numbers before asking for confirmation.
- **Dry run.** The same code path as a real run, with the Discord write skipped and actions
  recorded as `DRY_RUN`.
- **Production fails closed.** `DEV_MODE` and `DISCORD_MOCK` are forced off when
  `NODE_ENV=production`, and required secrets abort startup if missing.

## Sources of truth

| Data                                                                                                 | Authority                                 |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Department membership, rank, command status, callsign, certifications, subdivisions, LOA, suspension | Roster (the database)                     |
| Notification, event, interest and cosmetic roles                                                     | Discord, via mappings — or nothing at all |
| Temporary sensitive access, investigation access, event assignments                                  | Manual grants, time-bounded               |

When the two disagree, the configured authority decides. For roster-authoritative roles
that means a manual Discord change is reverted on the next reconciliation, by design.
