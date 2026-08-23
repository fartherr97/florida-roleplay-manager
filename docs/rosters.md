# Rosters

A roster is a published list of who holds which rank — the staff team, or one department's
chain of command — kept in agreement with Discord and served to the community website.

The rule the whole subsystem rests on:

> **Holding a bound Discord role _is_ being that rank.**

Nobody is added to a roster by hand. There is no command that puts somebody on one, because
a second way of getting onto a roster is a second source of truth, and the two would drift
apart within a week. Give a member the Senior Administrator role in Discord and they appear
on the roster as Senior Administrator; take every rank role away and they come off it.

## What happens on a promotion

1. An administrator gives the member their new role in Discord.
2. The bot's `guildMemberUpdate` handler notices that a changed role is bound to a rank on
   some roster, and queues a roster job. (This is evaluated independently of role
   synchronization — a rank role is usually neither mapped nor platform-managed, so the
   mapping check saying "nothing to do" must not skip the roster.)
3. The worker recomputes that member's whole correct state: which rank they hold now, and
   what their nickname should read.
4. It writes the membership row first, then the nickname. That order is deliberate — a
   rename that fails leaves an accurate roster and a recorded issue, not a member missing
   from the website because Discord rate-limited us.
5. The website's next request sees the new state.

Demotions, transfers, someone leaving the server and someone being stripped of everything
all take the same path. None of them is a special case: the reconciler computes the whole
answer from current roles every time.

## Nicknames

The managed format is:

```
Callsign | Rank | Name        165 | Jr. Admin | Mike
Rank | Name                   Jr. Admin | Mike        (no callsign set)
Callsign | Name               165 | Mike              (no rank — they left the roster)
Name                          Mike                    (neither)
```

Two properties are enforced by
[`roster-nickname.js`](../packages/core/src/roster-nickname.js) and tested directly:

- **Rendering is idempotent.** The renderer never appends to what is already there. It
  parses the current nickname, takes the _name_ out of it, and rebuilds the whole string.
  Without that, every sync would add another prefix until somebody reads
  `165 | Sr. Admin | 165 | Admin | 165 | Mod | Mike`.
- **The name belongs to the member.** A rank change rewrites the rank and leaves the name
  alone. When somebody comes off a roster the platform takes back the prefix it wrote and
  gives them their plain name — it does not clear their nickname.

Discord's 32-character limit is enforced by truncating the **name**, never the callsign or
the rank, so two people are never truncated into looking like the same person.

### Which name is used

| Source          | Set by                                                        | Wins when                                                      |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `preferredName` | An administrator, via `/roster member name:`                  | Always, when set. A member cannot rename themselves out of it. |
| `displayName`   | Derived on each sync from their nickname, then their username | No override is set.                                            |

So a member who renames themselves from `Mike` to `Mikey` keeps `Mikey` — the platform puts
the rank prefix back around it. A member whose name was pinned by an administrator gets the
pinned name restored. That distinction is the reason there are two columns.

### When a nickname cannot be written

The roster is still correct; only the rename fails, and it is recorded as a `SyncIssue`:

- **The server owner.** Discord does not let any bot rename the guild owner. No permission
  changes this. Set their nickname by hand once.
- **A member who outranks the bot.** Discord refuses when the member's highest role is at or
  above the bot's. Move the bot's role up — see [Discord setup](discord-setup.md).
- **Missing Manage Nicknames.** Re-invite the bot with the permission.

All three are checked _before_ the API call, because Discord reports every one of them as a
bare `50013` that reads as "missing permission" and sends you looking in the wrong place.

## Loop protection

The bot writes nicknames, and Discord reports the bot's own write back to it as a
`guildMemberUpdate`. The nickname handler restores the managed format when somebody edits it
by hand — so without protection the bot would read its own rewrite as a hand edit and rewrite
it, forever.

Before every rename the worker writes a short-lived Redis marker keyed on
`(guild, member)`; the handler _claims_ it atomically and recognises the event as its own
echo. Markers are single-use, so a genuine edit after ours is still corrected. This is the
same mechanism role synchronization uses, in its own key space — a nickname change has no
role in it, so it could not reuse the role marker key.

If Redis is unreachable the handler fails safe and ignores the event, exactly as the role
path does: a missed correction is repaired by the scheduled sweep, whereas a rename loop is
not self-healing.

## The website API

Public and unauthenticated — a public roster page has no session to present — so the
response contains only what already appears on that page. No platform user ids, no audit
data, and unpublished rosters are not served at all.

```
GET /api/rosters
GET /api/rosters/:slug
```

```jsonc
{
  "roster": {
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
}
```

Ranks come back in seniority order, highest first. Members are sorted by callsign —
numerically where the callsign is a number, so `9` comes before `165` — then by name.
Responses carry an `ETag` and `Cache-Control: public, max-age=60`; send `If-None-Match` and
you will get a `304` when nothing has changed.

The management endpoints under `/api/rosters/manage/*` are session-authenticated and enforce
the same capabilities as the Discord commands.

## Configuration

```
/roster create   slug:staff name:"Staff Team"
/roster rank     roster:staff role:@Moderator      name:"Moderator"            seniority:10 short_name:"Mod"
/roster rank     roster:staff role:@Senior Admin   name:"Senior Administrator" seniority:30 short_name:"Sr. Admin"
/roster sync     roster:staff                      # brings existing staff in
```

`seniority` decides two things: the order ranks appear on the website, and which rank wins
when a member holds several bound roles at once — which happens constantly, because a
promotion where nobody removed the old role is the normal case, not the exception. Highest
seniority always wins, so the answer never depends on row order.

A roster with **no** ranks bound is skipped entirely rather than reconciled. Reconciling it
would read as "nobody holds a rank" and empty the roster, which is not what a half-configured
roster means.

## Capabilities

| Capability      | Minimum tier | For                                   |
| --------------- | ------------ | ------------------------------------- |
| `roster.view`   | Supervisor   | Viewing rosters and their members     |
| `roster.member` | Command      | Setting a callsign or a name override |
| `roster.sync`   | Command      | Running a reconciliation              |
| `roster.manage` | Manager      | Creating rosters and binding ranks    |

## Scheduled reconciliation

Every roster is swept on the same schedule as role reconciliation (`RECONCILE_CRON`), so
drift from a missed event or a bot restart repairs itself. Because reconciliation is
idempotent this is almost always a no-op: a sweep over a correct roster performs **no**
Discord writes at all, which is what makes it safe to run often.

## Relationship to the removed roster subsystem

An earlier, larger roster subsystem was removed in migration `20260803224212` (commit
`679ea61`). It ran in the opposite direction — the roster was the source of truth and roles
were computed from it — and carried departments, certifications, subdivisions and LOA
tracking with it. This one is the inverse and deliberately much smaller: Discord roles
decide, and the roster is a projection of them. The tables share no names with the old ones.
