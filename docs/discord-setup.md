# Discord application setup

## 1. Create the application

1. Go to <https://discord.com/developers/applications> and **New Application**.
2. Copy the **Application ID** into `DISCORD_CLIENT_ID`.
3. Under **Bot**, press **Reset Token** and copy it into `DISCORD_BOT_TOKEN`.
   This token is equivalent to full control of every server the bot is in. It belongs only
   in the environment of the bot and worker processes — never in the API, never in a
   frontend, never in a commit.

## 2. Privileged intents

Under **Bot → Privileged Gateway Intents**, enable:

- **Server Members Intent** — required. Without it the bot cannot see member role changes
  or fetch members, and synchronization cannot work at all.
- **Message Content Intent** — _not_ required. Leave it off.

## 3. Bot permissions

The bot needs these permissions:

| Permission          | Why                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manage Roles**    | To add and remove roles. Without it every write fails with a permanent, non-retryable error.                                                                                                  |
| **Manage Channels** | Only needed for `/setup department`, which creates the server's categories and channels. Role synchronization works without it; provisioning refuses to run until the bot has it.             |
| **View Audit Log**  | Optional but recommended: it lets the bot attribute manual role changes to the person who made them in the audit trail. Everything works without it; the actor is simply recorded as unknown. |

Permission integer: `268435456` (Manage Roles), `268435584` (with View Audit Log), or
`268435600` (Manage Roles + Manage Channels + View Audit Log — needed for `/setup`).

## 4. Invite the bot

```
https://discord.com/api/oauth2/authorize
  ?client_id=<DISCORD_CLIENT_ID>
  &permissions=268435600
  &scope=bot%20applications.commands
```

The `applications.commands` scope is required for slash commands.

**Invite it to the approved servers only.** In production the bot audits, alerts and then
leaves any server that is not on the allowlist.

## 5. Role hierarchy — the step everybody misses

Discord will not let a bot manage a role that sits at or above the bot's own highest role
in the list. This is the single most common cause of "synchronization silently does
nothing".

In **Server Settings → Roles**, drag the bot's role **above every role the platform will
manage**, in every approved server.

A good layout:

```
  Owner
  Administrator
  ── Florida Roleplay Manager   ← the bot's role, above everything it manages
  Command Staff
  Supervisor
  Sergeant
  Corporal
  Deputy
  Department Member
  BLET Certified
  @everyone
```

`/guild status` reports the bot's position and names every managed role that is currently
above it. Run it after any change to the role list.

Two kinds of role can never be managed, regardless of hierarchy:

- **Integration-owned roles** — bot roles, Server Booster, Twitch/YouTube subscriber roles.
  Discord itself forbids assigning them; the platform refuses them at mapping time with a
  clear message.
- **@everyone** — refused explicitly.

## 6. Register the slash commands

The bot registers its commands automatically on every boot, so a normal deploy needs no
separate step. What it does depends on `DEV_GUILD_IDS`:

- **`DEV_GUILD_IDS` set (guild-scoped, instant).** On boot it registers the commands in
  every server the bot is currently in, and again the moment it joins (and stays in) a new
  one. This is the right choice for a fixed set of servers - one community plus a handful of
  departments - because commands appear immediately, with no propagation delay. Set it to
  at least your main community server's ID.
- **`DEV_GUILD_IDS` empty (global).** Commands are registered once, globally, and appear in
  every server the bot is in - but Discord can take up to an hour to show them.

You can also register by hand:

```bash
npm run commands:register -- --guild   # instant, uses DEV_GUILD_IDS
npm run commands:register              # global, up to an hour to propagate
```

Do not mix the two: a server registered both globally and guild-scoped shows every command
twice. If you switch from global to guild-scoped, clear the global set first with
`npm run commands:clear`.

If commands do not appear in a newly joined server, the usual cause is global mode (just
wait) or a server that joined while `DEV_GUILD_IDS` was empty; setting `DEV_GUILD_IDS` and
redeploying the bot registers every server it is in.

## 7. Register the guilds with the platform

Slash-command visibility is not authorization, and being in a server is not approval. Each
server must be registered by a global administrator:

```
/guild register type:MAIN_COMMUNITY reason:main community server
/guild register guild_id:<id> type:DEPARTMENT reason:HCSO department server
```

Registering from Discord verifies the bot's presence and permissions live. Registering
through the API (which has no Discord connection) creates the guild with synchronization
disabled until it is verified.

By default the bot leaves any server it is added to that is not yet approved, which would
kick it out before you can register a new one. To onboard a server, first pause auto-leave
from an already-approved server, invite the bot, approve the new server (either
`/guild register` or the full `/setup department`, which registers as part of the flow),
then turn auto-leave back on:

```
/guild autoleave enabled:false reason:onboarding the department servers
# ...invite the bot to each new server and run /setup department or /guild register...
/guild autoleave enabled:true
```

Then confirm everything is healthy:

```
/guild status
/system health
```

## 8. OAuth for the website (optional)

Only needed when the dashboard is deployed.

1. **OAuth2 → Redirects**: add `https://your-api-host/api/auth/discord/callback`.
2. Copy the **Client Secret** into `DISCORD_CLIENT_SECRET`.
3. Set `DISCORD_OAUTH_REDIRECT_URI` to the same URL.

The API requests only the `identify` scope. Signing in never creates an account: a Discord
account that is not already linked to a member is refused, and linking is a deliberate,
audited action (`/member link`).

## 9. Administrator alerts (optional)

`ADMIN_ALERT_WEBHOOK_URL` receives a message when something needs human attention:

- the bot is added to a server that is not on the allowlist;
- a job pauses on the maximum-change threshold;
- a synchronized role is deleted;
- mapping validation disables broken mappings;
- the bot is removed from an approved server.

Create it in a private staff channel — **Channel Settings → Integrations → Webhooks**. The
URL is a secret and is redacted from logs.
