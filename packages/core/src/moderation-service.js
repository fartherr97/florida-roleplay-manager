/**
 * Community-wide moderation: banning and unbanning a user across every registered guild.
 *
 * A deliberate manual action for the operators who run the whole community, so it is
 * gated at the highest level (system.manage) and every use is both audited and posted to
 * the mod-log webhook. Ban works by user id, so it applies whether or not the user is
 * currently a member — a raid account that already left is still banned. Unban treats a
 * guild where the user was never banned as a no-op, not a failure.
 *
 * A ban may carry a duration ("7d", "6h", …). The ban itself lives in Discord and is
 * permanent there; the expiry is a `TimedBan` row plus a maintenance sweep that lifts it
 * everywhere once the time passes. A permanent ban writes no row — it never needs lifting.
 */
import { authorize } from '@frm/authorization';
import { AuditAction, SyncIssueType, ValidationError, formatDuration } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { recordAudit } from './audit-service.js';
import { notifyModLog } from './notify.js';
import { systemContext } from './context.js';

const log = createLogger('core.moderation');

const SNOWFLAKE = /^\d{17,20}$/;
const BAN_COLOR = 0xe74c3c;
const UNBAN_COLOR = 0x2ecc71;

function approvedGuilds(prisma) {
  return prisma.approvedGuild.findMany({
    where: { deletedAt: null, enabled: true },
    select: { discordGuildId: true, name: true },
    orderBy: { name: 'asc' },
  });
}

function moderatorLabel(ctx) {
  const name = ctx.actor?.user?.displayName;
  const id = ctx.actor?.discordUserId;
  if (name && id) return `${name} (<@${id}>)`;
  if (id) return `<@${id}>`;
  return name ?? 'System';
}

function perServerText(results) {
  const lines = results.map((entry) => {
    if (entry.status === 'applied') return `Applied — ${entry.guild}`;
    if (entry.status === 'absent') return `Skipped — ${entry.guild}${entry.message ? ` (${entry.message})` : ''}`;
    return `Failed — ${entry.guild}: ${entry.message}`;
  });
  return lines.join('\n') || '—';
}

/** Bans across a set of guilds, one at a time, collecting a per-guild result. */
async function banAcross(gateway, guilds, id, { reason, deleteMessageSeconds }) {
  const results = [];
  for (const guild of guilds) {
    try {
      await gateway.banMember(guild.discordGuildId, id, { reason, deleteMessageSeconds });
      results.push({ guild: guild.name, status: 'applied' });
    } catch (error) {
      if (error?.issueType === SyncIssueType.GUILD_UNAVAILABLE) {
        results.push({ guild: guild.name, status: 'absent', message: 'bot not in server' });
        continue;
      }
      const message =
        error?.issueType === SyncIssueType.BOT_MISSING_PERMISSION
          ? "The bot needs Ban Members and a role above the target — the server owner can't be banned."
          : (error?.userMessage ?? error?.message ?? 'failed');
      results.push({ guild: guild.name, status: 'failed', message });
      log.warn({ discordGuildId: guild.discordGuildId, discordUserId: id, err: serializeError(error) }, 'ban failed in a guild');
    }
  }
  return results;
}

/** Lifts a ban across a set of guilds; a guild where the user was not banned is skipped. */
async function unbanAcross(gateway, guilds, id, reason) {
  const results = [];
  for (const guild of guilds) {
    try {
      const outcome = await gateway.unbanMember(guild.discordGuildId, id, reason);
      results.push(
        outcome?.applied
          ? { guild: guild.name, status: 'applied' }
          : { guild: guild.name, status: 'absent', message: 'not banned there' },
      );
    } catch (error) {
      if (error?.issueType === SyncIssueType.GUILD_UNAVAILABLE) {
        results.push({ guild: guild.name, status: 'absent', message: 'bot not in server' });
        continue;
      }
      const message =
        error?.issueType === SyncIssueType.BOT_MISSING_PERMISSION
          ? 'The bot needs the Ban Members permission.'
          : (error?.userMessage ?? error?.message ?? 'failed');
      results.push({ guild: guild.name, status: 'failed', message });
      log.warn({ discordGuildId: guild.discordGuildId, discordUserId: id, err: serializeError(error) }, 'unban failed in a guild');
    }
  }
  return results;
}

/**
 * Bans a user from every registered guild.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {string} input.discordUserId
 * @param {string} [input.reason]
 * @param {number} [input.deleteMessageDays] 0–7, how much recent message history to purge
 * @param {number|null} [input.durationMs] ban length in ms; null/omitted = permanent
 * @param {object} input.gateway the Discord gateway
 */
export async function banGlobally(ctx, { discordUserId, reason, deleteMessageDays = 0, durationMs = null, gateway }) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });

  const id = String(discordUserId ?? '').trim();
  if (!SNOWFLAKE.test(id)) throw new ValidationError('That is not a valid Discord user id.');
  const days = Math.min(7, Math.max(0, Math.trunc(Number(deleteMessageDays) || 0)));
  const banReason = String(reason ?? '').trim() || `Global ban by ${ctx.actor?.user?.displayName ?? 'an operator'}`;
  const expiresAt = durationMs && durationMs > 0 ? new Date(Date.now() + durationMs) : null;

  const guilds = await approvedGuilds(ctx.prisma);
  const results = await banAcross(gateway, guilds, id, { reason: banReason, deleteMessageSeconds: days * 86400 });
  const applied = results.filter((r) => r.status === 'applied').length;

  // Record the timer for a temp ban. Supersede any earlier active timer for this user so
  // the sweep never races two rows to the same unban.
  if (expiresAt) {
    await ctx.prisma.timedBan
      .updateMany({
        where: { discordUserId: id, active: true },
        data: { active: false, liftedAt: new Date(), liftedReason: 'superseded' },
      })
      .catch(() => {});
    await ctx.prisma.timedBan
      .create({
        data: {
          discordUserId: id,
          reason: banReason,
          bannedByLabel: moderatorLabel(ctx),
          bannedById: ctx.actor?.user?.id ?? null,
          expiresAt,
        },
      })
      .catch((error) => log.error({ err: serializeError(error) }, 'failed to record timed ban'));
  }

  const expiryText = expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : 'Permanent';

  await recordAudit(ctx.prisma, {
    ctx,
    action: AuditAction.MEMBER_GLOBAL_BANNED,
    targetDiscordId: id,
    newState: { reason: banReason, deleteMessageDays: days, expiresAt: expiresAt?.toISOString() ?? null, appliedIn: applied, guilds: results },
    reason: banReason,
  }).catch(() => {});

  await notifyModLog({
    title: expiresAt ? 'Global temp ban' : 'Global ban',
    description: `<@${id}> (\`${id}\`) was banned in **${applied} of ${guilds.length}** registered servers.`,
    color: BAN_COLOR,
    fields: [
      { name: 'Moderator', value: moderatorLabel(ctx), inline: true },
      { name: 'Duration', value: expiresAt ? formatDuration(durationMs) : 'Permanent', inline: true },
      { name: 'Expires', value: expiryText, inline: true },
      { name: 'Deleted history', value: days ? `${days} day${days === 1 ? '' : 's'}` : 'None', inline: true },
      { name: 'Reason', value: banReason },
      { name: 'Per server', value: perServerText(results) },
    ],
  }).catch(() => {});

  return { discordUserId: id, total: guilds.length, applied, expiresAt, results };
}

/**
 * Lifts a user's ban in every registered guild.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {string} input.discordUserId
 * @param {string} [input.reason]
 * @param {object} input.gateway the Discord gateway
 */
export async function unbanGlobally(ctx, { discordUserId, reason, gateway }) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });

  const id = String(discordUserId ?? '').trim();
  if (!SNOWFLAKE.test(id)) throw new ValidationError('That is not a valid Discord user id.');
  const unbanReason = String(reason ?? '').trim() || `Global unban by ${ctx.actor?.user?.displayName ?? 'an operator'}`;

  const guilds = await approvedGuilds(ctx.prisma);
  const results = await unbanAcross(gateway, guilds, id, unbanReason);
  const applied = results.filter((r) => r.status === 'applied').length;

  // A manual unban cancels any pending timer for this user.
  await ctx.prisma.timedBan
    .updateMany({
      where: { discordUserId: id, active: true },
      data: { active: false, liftedAt: new Date(), liftedReason: 'manual' },
    })
    .catch(() => {});

  await recordAudit(ctx.prisma, {
    ctx,
    action: AuditAction.MEMBER_GLOBAL_UNBANNED,
    targetDiscordId: id,
    newState: { reason: unbanReason, appliedIn: applied, guilds: results },
    reason: unbanReason,
  }).catch(() => {});

  await notifyModLog({
    title: 'Global unban',
    description: `<@${id}> (\`${id}\`) was unbanned in **${applied} of ${guilds.length}** registered servers.`,
    color: UNBAN_COLOR,
    fields: [
      { name: 'Moderator', value: moderatorLabel(ctx), inline: true },
      { name: 'Reason', value: unbanReason },
      { name: 'Per server', value: perServerText(results) },
    ],
  }).catch(() => {});

  return { discordUserId: id, total: guilds.length, applied, results };
}

/**
 * The maintenance sweep: lift every timed ban whose time has passed.
 *
 * Runs on the maintenance schedule, so a temp ban still expires even if the bot was
 * restarting when it should have. Best effort per ban — a guild the bot cannot reach is
 * reported, not fatal — and idempotent: a row is flipped inactive as soon as it is swept.
 *
 * @param {{gateway: object, prisma: object}} deps
 */
export async function runTimedBanExpiry({ gateway, prisma }) {
  const now = new Date();
  const due = await prisma.timedBan.findMany({
    where: { active: true, expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: 50,
  });
  if (due.length === 0) return { expired: 0 };

  const guilds = await approvedGuilds(prisma);
  const ctx = systemContext({ scheduled: true, label: 'timed-ban-expiry' });

  for (const ban of due) {
    const results = await unbanAcross(gateway, guilds, ban.discordUserId, 'Timed ban expired');
    const applied = results.filter((r) => r.status === 'applied').length;

    await prisma.timedBan
      .update({ where: { id: ban.id }, data: { active: false, liftedAt: now, liftedReason: 'expired' } })
      .catch((error) => log.error({ err: serializeError(error), banId: ban.id }, 'failed to close timed ban'));

    await recordAudit(prisma, {
      ctx,
      action: AuditAction.MEMBER_GLOBAL_UNBANNED,
      targetDiscordId: ban.discordUserId,
      newState: { expired: true, appliedIn: applied },
      reason: 'Timed ban expired',
    }).catch(() => {});

    await notifyModLog({
      title: 'Timed ban expired',
      description: `<@${ban.discordUserId}> (\`${ban.discordUserId}\`)'s timed ban expired and was lifted in **${applied} of ${guilds.length}** registered servers.`,
      color: UNBAN_COLOR,
      fields: [
        { name: 'Original reason', value: ban.reason ?? '—' },
        { name: 'Per server', value: perServerText(results) },
      ],
    }).catch(() => {});
  }

  log.info({ expired: due.length }, 'timed bans swept');
  return { expired: due.length };
}
