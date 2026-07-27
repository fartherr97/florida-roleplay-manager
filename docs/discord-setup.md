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

The bot needs exactly two permissions:

| Permission         | Why                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manage Roles**   | To add and remove roles. Without it every write fails with a permanent, non-retryable error.                                                                                                  |
| **View Audit Log** | Optional but recommended: it lets the bot attribute manual role changes to the person who made them in the audit trail. Everything works without it; the actor is simply recorded as unknown. |

Permission integer: `268435456` (Manage Roles) or `268435584` (with View Audit Log).

## 4. Invite the bot

```
https://discord.com/api/oauth2/authorize
  ?client_id=<DISCORD_CLIENT_ID>
  &permissions=268435584
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

```bash
npm run commands:register -- --guild   # instant, uses DEV_GUILD_IDS
npm run commands:register              # global, up to an hour to propagate
```

Use guild registration while developing and global registration in production.

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
