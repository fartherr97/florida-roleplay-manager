# New-session prompt: FLRP Roster Tracker

Paste everything below the line into a fresh Claude Code session on this repository.

---

## What I want built

I'm adding a **FLRP Roster Tracker** capability to this project. The idea: **Discord roles are
the source of truth, and they drive the staff rosters on our website.**

Concretely:

- When a member is **promoted** (e.g. Moderator → Senior Admin), the moment they get the new
  role in Discord the bot rewrites their Discord display name and moves them to the correct
  rank section of the roster.
- When a member is **added to a staff team**, they're added to that roster automatically.
- When **all of a member's staff roles are stripped**, they're removed from the roster and
  their managed nickname is cleaned up.
- Demotions, department transfers, and someone leaving the Discord entirely are handled by the
  same path — nothing is a special case, it's all "recompute from current roles."

**Nickname format:** `Callsign | Rank | Name` — e.g. `165 | Jr. Admin | Mike`, `905 | Major | Gene`.

**Where roster data lives:** this bot owns it in Postgres and exposes it over the existing REST
API. Our website reads that API and renders the roster pages. The bot does not scrape or write
to the website directly.

**One bot, not two.** This ships as part of the existing Florida Roleplay Manager bot — same
application, same token, same invite. That decision is made; don't re-open it. The reason: the
roster tracker triggers on `guildMemberUpdate` role changes, which is the same signal the role
sync engine already acts on, and it needs the same Redis loop-protection markers to tell "the bot
did this" from "a human did this." A second gateway connection can't read those markers, so it
would rename people in response to the first bot's own writes. If you want the roster work
isolated for blast radius, isolate it as its own queue lane or worker process inside this repo —
not as a second bot.

## Ground rules for this codebase

This is an existing, working monorepo (`florida-roleplay-manager`). Build the roster tracker
**inside it**, following its existing architecture — do not start a separate project.

- Node 20 ESM, npm workspaces: `apps/*` (`bot`, `api`, `worker`) and `packages/*`
  (`core`, `shared`, `database`, `discord`, `queue`, `reconciliation`, `authorization`,
  `validation`, `logging`).
- **All decision logic lives in `packages/core`.** The bot and API are thin adapters. The bot
  observes and enqueues; it never writes to Discord.
- **`apps/worker` is the only process that writes to Discord.** Nickname writes are Discord
  writes — they belong in the worker, behind the queue, not in an event handler.
- Loop protection is mandatory: `packages/queue/src/markers.js` writes a short-lived Redis
  marker before a bot-initiated change so the resulting gateway event is recognised as our own.
  A nickname write produces a `guildMemberUpdate` too — it needs the same treatment, with a
  marker kind for nickname changes.
- Prisma is the schema (`prisma/schema.prisma`, 688 lines, ~20 models). Add models + a
  migration; don't hand-edit migration SQL.
- Tests are vitest: `tests/unit` and `tests/integration`, with a mock gateway
  (`packages/discord/src/mock-gateway.js`) and helpers in `tests/helpers`. `npm run check`
  runs lint + tests and must pass.
- Read `README.md` and `docs/architecture.md` before writing code, and follow the existing
  file/comment style — the codebase explains _why_, not _what_.

## Before you write code

Read the repo first, then **ask me the open questions** (use AskUserQuestion, batch them).
The ones I know I'll need to answer:

1. **Roster structure.** How many rosters, and what are they? (staff team vs. per-department —
   this repo already models a main community guild plus one guild per department.)
2. **Rank list.** The exact ranks per roster, their order, their Discord role IDs, and the short
   form used in the nickname (`Jr. Admin` vs `Junior Administrator`).
3. **Callsign source.** Where does `165` come from — do I type it in via a command, does it come
   from the site, or is it derived? What renders when someone has no callsign yet?
4. **Which guilds get nickname sync** — main community server only, or department servers too?
5. **The "Name" part.** Preferred name stored by the bot, or "whatever's in their nickname now,
   minus our managed prefix"?
6. **What the website needs** — the exact JSON shape, and whether the roster endpoints should be
   public/unauthenticated (cached) or read-key protected.
7. **Nickname cleanup on removal** — strip back to the bare name, or leave whatever's there?

Don't block on all of them if you can make progress with a stated assumption — but the rank list
and callsign source you'll want up front.

## Requirements

### Data model

- A roster (name, slug, which guild, display order, whether it's published to the site).
- A rank: belongs to a roster, bound to a **Discord role ID**, with a display label, a short
  label for the nickname, and a sort position that decides precedence.
- A roster membership: user, roster, current rank, callsign, preferred name, joined/left
  timestamps. Keep departures as history (soft-remove) rather than deleting rows.
- Reuse the existing `User` / `DiscordIdentity` / `ApprovedGuild` / `AuditLog` models rather
  than inventing parallel ones.

### Rank resolution

- A member may hold several bound roles at once. **Highest sort position wins** — that's their
  rank; deterministic, no "first match" ordering by accident.
- Zero bound roles → not on the roster.
- Resolution is a pure function over (member's role IDs, rank config). Unit-test it.

### Nickname rendering

- Render `Callsign | Rank | Name`, degrading sensibly when a part is missing.
- **Rendering must be idempotent and parseable.** Re-running on an already-formatted nickname
  must produce the same string, never `165 | Jr. Admin | 165 | Mod | Mike`. Write the parser and
  the renderer together and test the round-trip.
- Discord's nickname limit is 32 characters — define and test the truncation rule (truncate the
  name, never the callsign or rank).
- Handle the cases that will happen in production: the bot cannot rename the **guild owner**, and
  cannot rename anyone whose highest role sits above the bot's own role. Both must surface as a
  recorded sync issue, not a crash and not a silent no-op.

### Events and jobs

- Extend the role-change path in `packages/core/src/event-service.js` so a relevant role change
  also enqueues roster work. A role change that touches no bound role must enqueue nothing.
- Add a roster sync job type (`SyncJobType` in `packages/shared`, the queue name map and
  `JOB_NAME_FOR_TYPE` in `packages/queue/src/queues.js`, and a branch in
  `apps/worker/src/processors.js`). There's an `enum-parity` unit test that will keep you honest.
- Add `setNickname` to `packages/discord/src/gateway.js` and to the mock gateway, with the same
  error-classification treatment as `addRole`/`removeRole` in `packages/discord/src/errors.js`.
- Per-member locking, retry/backoff, and the max-change threshold that pauses mass removals
  already exist — reuse them, don't re-implement.

### Reconciliation

- Desired roster state is computed from Discord roles, exactly like the role engine:
  desired − actual = changes. Idempotent, safe to run repeatedly.
- Add a scheduled roster sweep so drift (changes made while the bot was down) self-heals, and a
  `dry-run` mode consistent with `SYNC_DRY_RUN_DEFAULT`.

### Slash commands (`apps/bot/src/commands/`)

A `/roster` command group, matching the style of the existing `/mapping` and `/access` commands:

- configure a roster and bind role → rank
- view a roster in Discord
- set/clear a member's callsign and preferred name
- resync one member / one roster, with a preview of what would change before it's applied

Guard every subcommand through the existing capability + access-tier system; add new capabilities
to the catalogue in `packages/shared` rather than reusing an unrelated one.

### API for the website

- `GET /api/rosters` and `GET /api/rosters/:slug` returning ranks in order, each with its members
  (callsign, rank, name, Discord id, avatar-ish fields as needed).
- Stable, documented JSON shape — the website is going to hard-code against it.
- ETag / cache headers; sensible rate limiting. Follow the existing route + zod validation pattern
  in `apps/api/src/routes/resources.js` and `packages/validation`.

### Audit + observability

Every roster add, removal, rank change, callsign change and nickname write goes to the audit log
with actor, before/after and correlation id — same as every other action in this system.

### Tests

- Unit: rank precedence, nickname render/parse round-trip, truncation, "no bound roles" cases.
- Integration: role added → roster membership created + nickname written (mock gateway);
  promotion → rank moves and nickname updates; **all staff roles stripped → removed from roster
  and nickname cleaned**; and a loop-protection test proving our own nickname write doesn't
  trigger another sync.

### Docs / setup

- Update `README.md`, `docs/discord-setup.md` (the bot now needs **Manage Nicknames**, and its
  role must sit **above** every staff role it renames), `docs/environment.md` and `.env.example`
  for any new settings.
- The bot is already live under the existing token — no new application to configure. Tell me
  exactly what I need to change on the existing one: the added permission bits, whether the
  Server Members privileged intent is already required by the current code or is new, and the
  re-invite URL if the permission integer changes. Also state plainly that the bot's own role has
  to be dragged above the staff roles in the role list, because that's the failure everyone hits.

## How to work

Plan first and show me the plan before implementing. Then work in reviewable stages —
schema + core logic + tests, then worker/gateway, then commands, then API, then docs — running
`npm run check` at each stage. Commit as you go on branch `claude/flrp-roster-tracker-bot-6y26kr`
with descriptive messages. Don't open a PR unless I ask.
