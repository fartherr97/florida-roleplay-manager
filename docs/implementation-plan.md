# Implementation Plan and Risk Analysis

This document is the design output that precedes the code. It records the architecture
risks that were identified up front, the phased plan, and the decisions that the
implementation is required to honour.

**Scope note.** An earlier revision of this design also carried a department roster
subsystem — departments, rank ladders, memberships, certifications, subdivisions, and
leave/suspension/transfer tracking. It was removed at the project owner's request. What
remains is a focused cross-guild role platform: the allowlist, managed role definitions,
mappings, manual grants, permissions, and the synchronization engine. This document
describes the delivered design, not the earlier one.

## 1. Architecture risks identified before implementation

| #   | Risk                                                                                   | Consequence if ignored                 | Mitigation implemented                                                                                          |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R1  | Infinite synchronization loops between two-way mapped guilds                           | Discord API ban, role thrash           | Redis sync markers with TTL, single-use consumption, cycle detection at mapping creation                        |
| R2  | Reconciliation removing roles it does not own                                          | Community members lose unrelated roles | Explicit "managed role universe"; removals restricted to that set                                               |
| R3  | Non-deterministic desired state (two-way mappings with no authority)                   | Reconciler flip-flops on every run     | TWO_WAY convergence rule (union for adds, removal only via events unless an authority side is configured)       |
| R4  | A hostile or careless guild owner installing the bot and mapping into community guilds | Cross-community privilege leak         | Allowlist enforced in the backend on every command and every mapping side; auto-leave on unapproved join        |
| R5  | Privilege escalation through scope confusion (guild admin acting globally)             | Whole platform compromise              | Capability + scope + level-ceiling evaluated server side for every action                                       |
| R6  | IDOR: frontend or slash command supplying arbitrary IDs                                | Cross-guild configuration tampering    | Every ID from an untrusted boundary is re-resolved and re-authorized against the actor                          |
| R7  | Mass removal caused by a bad mapping or a bad migration                                | Community-wide role wipe               | Max-change threshold pauses jobs; previews required for large actions                                           |
| R8  | Audit log tampering                                                                    | Loss of accountability                 | Append-only service API, no update/delete paths, DB-level guidance in docs                                      |
| R9  | Bot token or DB credential leakage through logs or API errors                          | Full takeover                          | Central redaction list in the logger, env-only secrets, sanitized error responses                               |
| R10 | Split brain between DB commit and queue enqueue                                        | A change is never synchronized         | Enqueue after commit; failure recorded as a `SyncIssue` and retryable; scheduled reconciliation is the backstop |
| R11 | Concurrent syncs for the same member                                                   | Duplicate/contradictory role calls     | Per-member Redis mutex plus deterministic BullMQ job IDs                                                        |
| R12 | Discord role hierarchy changes underneath us                                           | Silent failures                        | Pre-flight hierarchy validation per action, typed failures, `SyncIssue` records                                 |
| R13 | Business logic duplicated between bot and API                                          | Divergent authorization behaviour      | All logic lives in `@frm/core`; bot and API are thin adapters                                                   |
| R14 | A single developer leaving the project                                                 | Unmaintainable platform                | Modular packages, documented invariants, tests that encode the rules                                            |

## 2. Phased plan

1. Monorepo scaffold, tooling, Docker, environment validation.
2. `shared`, `logging`, `validation` packages.
3. Prisma schema, migration, seed, `database` package.
4. `authorization` package (capabilities, scopes, level ceilings).
5. `discord` package (role gateway abstraction, hierarchy pre-flight, mock gateway).
6. `reconciliation` package (desired state, diff, plan).
7. `queue` package (BullMQ, Redis sync markers, locks).
8. `core` services (guilds, managed roles, mappings, grants, members, sync, audit, permissions).
9. `worker` app (processors, scheduled reconciliation, thresholds).
10. `bot` app (events, slash commands, confirmations, previews).
11. `api` app (sessions, CSRF, rate limits, REST resources).
12. Tests, documentation, verification.

Each phase ends with `npm run lint` and `npm test`.

## 3. Database entity relationship outline

```
User 1──n DiscordIdentity                (Discord snowflake is the external identity)
User 1──n PermissionAssignment n──1 PermissionCapability
User 1──n ManualRoleGrant      n──1 ManagedRole
User 1──n AuditLog (as actor)  1──n AuditLog (as target)

ApprovedGuild 1──n ManagedRole           (the allowlist gates everything below it)
ApprovedGuild 1──n RoleMapping           (as source and as target)

SyncJob 1──n SyncAction
SyncJob 1──n SyncIssue
SyncAction 0──1 SyncIssue

RoleMapping 1──n SyncAction
RoleMapping 1──n AuditLog

PendingApproval 1──n PendingApprovalVote (two-person rule)
SystemSetting                            (singleton key/value configuration)
```

Key constraints:

- `DiscordIdentity.discordUserId` unique — one platform user per Discord account.
- `ApprovedGuild.discordGuildId` unique — a guild can only be approved once.
- `ManagedRole (approvedGuildId, discordRoleId)` unique — one managed definition per role.
- `PermissionAssignment (userId, capabilityKey, scopeType, scopeId)` unique, with `scopeId`
  stored as `''` rather than `NULL` so the constraint actually bites on global grants.
- `RoleMapping (sourceGuildId, sourceRoleId, targetGuildId, targetRoleId)` unique among
  non-deleted rows.
- Soft deletion (`deletedAt`) on `User`, `ApprovedGuild`, `RoleMapping`, `ManagedRole`.
- `AuditLog` has no soft delete and no update path: it is append-only.

## 4. Permission model

An actor is authorized only when **all** of the following hold:

1. **Capability** — the actor holds the required capability key (e.g. `mapping.create`).
2. **Scope** — the assignment's scope covers the resource: `GLOBAL` ⊃ `GUILD`.
3. **Minimum level** — the actor's `permissionLevel` meets the capability's minimum.
4. **Level ceiling** — the actor may not act on a user whose `permissionLevel` is greater
   than or equal to their own, may not act on a user above the assignment's
   `maxPermissionLevel`, and may not grant capabilities above their own level.
5. **Self-management rule** — an actor may never grant permissions to themselves; self
   service is limited to read operations and explicitly self-safe actions.
6. **Guild approval** — every guild touched by the action is on the allowlist and enabled.

The evaluation returns a structured decision (`allowed`, `reason`, `matchedAssignment`) so
that failures are auditable and produce user-friendly errors instead of generic denials.

Worked example — an HCSO administrator at level `STAFF` (80) holding `mapping.create`,
`grant.issue` and `permission.grant`, all at scope `GUILD:hcso` with `maxPermissionLevel`
of `COMMAND` (40):

- Create a mapping whose two sides are both HCSO roles → allowed.
- Create a mapping from the main community guild into HCSO → denied, scope: the capability
  is required for _both_ guilds.
- Issue a grant to a member at level 0 → allowed.
- Issue a grant to a global administrator → denied, level ceiling.
- Delegate `mapping.create` with a ceiling of 80 → denied, ceiling at or above their own.
- Delegate `sync.member` with a ceiling of 20 → allowed; a delegation may only narrow.
- Register a guild → denied, missing capability (`guild.register` is global-only).
- Grant themselves `system.manage` → denied, self-management rule.

## 5. Role synchronization flow

```
Website / Slash command
      │  (input validated with Zod)
      ▼
Core service  ── authorize(actor, capability, scope, ceilings)
      │
      ├── DB transaction: mapping/grant mutation + AuditLog + SyncJob row
      │
      ▼  (after commit)
BullMQ enqueue ── job id derived from target, so duplicates collapse
      │
      ▼
Worker ── acquire per-member Redis lock
      │
      ├── Reconciliation: desired state − actual state = actions
      │
      ├── Pre-flight per action (bot present, member present, role exists,
      │   not @everyone, not integration-managed, hierarchy, protection)
      │
      ├── Write sync marker to Redis (TTL) *before* the Discord call
      │
      ├── Apply via Discord role gateway
      │
      └── Persist SyncAction results, SyncIssue on failure, finish SyncJob
      ▼
Discord emits guildMemberUpdate
      │
      ▼
Bot event handler ── consume marker → recognised as system change → stop
                  └── no marker → evaluate mappings → maybe enqueue propagation
```

## 6. Synchronization loops and race conditions

**Loop L1 — two-way mapping ping-pong.** A→B applies a role, Discord emits the event in B,
the handler propagates back to A, forever. Broken by single-use Redis markers keyed by
`(guild, member, role, action)`; the marker is consumed with `GETDEL` so exactly one event
can claim it.

**Loop L2 — mapping cycle A→B→C→A.** Broken at write time: the mapping graph is checked for
cycles before a mapping is created or enabled, treating `TWO_WAY` as edges in both
directions.

**Loop L3 — authoritative-mapping fight.** A human manually adds the target role of an
authoritative mapping whose source role they do not hold. The next reconciliation computes
the correct value as "absent" and removes it. The manual change never wins permanently —
which is the point of choosing an authority side, and why `syncRemove` can be switched off
when that is not wanted.

**Race C1 — concurrent member syncs.** Two jobs for the same member race and issue
contradictory calls. Mitigated with a Redis mutex per member and deterministic job IDs.

**Race C2 — marker expiry before the event.** If Discord is slow and the marker expires, the
handler sees an unexplained change and may enqueue a redundant sync. That sync is
idempotent and converges, so the worst case is one wasted job. TTL is configurable.

**Race C3 — commit/enqueue split.** Handled by enqueueing after commit and recording a
`SyncIssue` when the enqueue fails; scheduled reconciliation repairs anything missed.

**Race C4 — role deleted mid-job.** Pre-flight re-checks role existence per action; a
deleted role produces a typed `ROLE_DELETED` issue rather than a crash.

**Race C5 — stale actual state.** The reconciler reads member roles at plan time; between
plan and apply the state may change. Applying is idempotent (adding an existing role is a
no-op) and the next run converges.

## 7. Security risks

| Risk                                                 | Control                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Random guild installs the bot and maps roles         | Allowlist checked in the backend for both mapping sides and every command; auto-leave in production                 |
| Slash-command option spoofing (arbitrary snowflakes) | Every option is Zod validated and re-resolved server side; guild and role IDs are checked against the actor's scope |
| Privilege escalation via permission grants           | A granter must hold the capability, in a covering scope, and may only narrow the ceiling; self-grants forbidden     |
| Lower authority managing higher authority            | Target level must be strictly below the actor's own, and within the assignment's `maxPermissionLevel`               |
| Mapping onto protected roles                         | Protection policy check plus optional two-person approval before activation                                         |
| Mass role removal                                    | Threshold guard pauses the job and raises an issue                                                                  |
| Audit tampering                                      | Append-only writes; no service method updates or deletes audit rows                                                 |
| Secret leakage                                       | Env-only secrets, startup validation, logger redaction, sanitized API errors                                        |
| CSRF / session theft                                 | SameSite cookies, signed session IDs in Redis, double-submit CSRF token for cookie-authenticated mutations          |
| Brute force / abuse                                  | Global and per-route rate limits, per-command cooldowns                                                             |
| SQL injection                                        | Prisma parameterized queries only; no raw string SQL built from user input                                          |
| Stack trace disclosure                               | Central error handler maps internal errors to safe messages with a correlation ID                                   |
