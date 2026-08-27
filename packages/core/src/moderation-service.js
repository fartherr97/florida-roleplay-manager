/**
 * Community-wide moderation: banning and unbanning a user across every registered guild.
 *
 * A deliberate manual action for the operators who run the whole community, so it is
 * gated at the highest level (system.manage) and every use is both audited and posted to
 * the mod-log webhook. Ban works by user id, so it applies whether or not the user is
 * currently a member — a raid account that already left is still banned. Unban treats a
 * guild where the user was never banned as a no-op, not a failure.
 */
import { authorize } from '@frm/authorization';
import { AuditAction, SyncIssueType, ValidationError } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { recordAudit } from './audit-service.js';
import { notifyModLog } from './notify.js';

const log = createLogger('core.moderation');

const SNOWFLAKE = /^\d{17,20}$/;
const BAN_COLOR = 0xe74c3c;
const UNBAN_COLOR = 0x2ecc71;

function approvedGuilds(ctx) {
  return ctx.prisma.approvedGuild.findMany({
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
  return name ?? 'Unknown';
}

function perServerText(results) {
  const lines = results.map((entry) => {
    if (entry.status === 'applied') return `Applied — ${entry.guild}`;
    if (entry.status === 'absent') return `Skipped — ${entry.guild}${entry.message ? ` (${entry.message})` : ''}`;
    return `Failed — ${entry.guild}: ${entry.message}`;
  });
  return lines.join('\n') || '—';
}

/**
 * Bans a user from every registered guild.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {string} input.discordUserId
 * @param {string} [input.reason]
 * @param {number} [input.deleteMessageDays] 0–7, how much recent message history to purge
 * @param {object} input.gateway the Discord gateway
 */
export async function banGlobally(ctx, { discordUserId, reason, deleteMessageDays = 0, gateway }) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });

  const id = String(discordUserId ?? '').trim();
  if (!SNOWFLAKE.test(id)) throw new ValidationError('That is not a valid Discord user id.');
  const days = Math.min(7, Math.max(0, Math.trunc(Number(deleteMessageDays) || 0)));
  const banReason = String(reason ?? '').trim() || `Global ban by ${ctx.actor?.user?.displayName ?? 'an operator'}`;

  const guilds = await approvedGuilds(ctx);
  const results = [];
  for (const guild of guilds) {
    try {
      await gateway.banMember(guild.discordGuildId, id, { reason: banReason, deleteMessageSeconds: days * 86400 });
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
      log.warn({ discordGuildId: guild.discordGuildId, discordUserId: id, err: serializeError(error) }, 'global ban failed in a guild');
    }
  }

  const applied = results.filter((r) => r.status === 'applied').length;

  await recordAudit(ctx.prisma, {
    ctx,
    action: AuditAction.MEMBER_GLOBAL_BANNED,
    targetDiscordId: id,
    newState: { reason: banReason, deleteMessageDays: days, appliedIn: applied, guilds: results },
    reason: banReason,
  }).catch(() => {});

  await notifyModLog({
    title: 'Global ban',
    description: `<@${id}> (\`${id}\`) was banned in **${applied} of ${guilds.length}** registered servers.`,
    color: BAN_COLOR,
    fields: [
      { name: 'Moderator', value: moderatorLabel(ctx), inline: true },
      { name: 'Deleted history', value: days ? `${days} day${days === 1 ? '' : 's'}` : 'None', inline: true },
      { name: 'Reason', value: banReason },
      { name: 'Per server', value: perServerText(results) },
    ],
  }).catch(() => {});

  return { discordUserId: id, total: guilds.length, applied, results };
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

  const guilds = await approvedGuilds(ctx);
  const results = [];
  for (const guild of guilds) {
    try {
      const outcome = await gateway.unbanMember(guild.discordGuildId, id, unbanReason);
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
      log.warn({ discordGuildId: guild.discordGuildId, discordUserId: id, err: serializeError(error) }, 'global unban failed in a guild');
    }
  }

  const applied = results.filter((r) => r.status === 'applied').length;

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
