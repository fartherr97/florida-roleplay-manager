/**
 * Setting a member's Discord nickname across every registered guild at once.
 *
 * This is a deliberate manual override, not reconciliation: an operator picks a member
 * and a name, and the bot writes that nickname into every approved guild the member is
 * in. It is the escape hatch for the cases the roster nickname sync does not cover — a
 * member on no roster, or a one-off correction — so it writes directly rather than
 * enqueuing a plan.
 *
 * Caveat worth stating plainly: in a guild where a roster owns this member's nickname
 * (nickname sync on, and they hold a bound rank), the next sync will rewrite it back to
 * the managed form. The override sticks where nothing else is managing the name.
 */
import { authorize } from '@frm/authorization';
import { AuditAction, SyncIssueType, ValidationError } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { recordAudit } from './audit-service.js';

const log = createLogger('core.nickname');

/** Discord caps a nickname at 32 characters. */
const NICKNAME_MAX = 32;

/**
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {string} input.discordUserId the member whose nickname to set
 * @param {string} input.nickname the new display name (1–32 chars)
 * @param {object} input.gateway the Discord gateway, for the per-guild writes
 * @param {string} [input.reason] audit-log reason shown in Discord
 * @returns {Promise<{nickname: string, total: number, applied: number, results: Array}>}
 */
export async function setGlobalNickname(ctx, { discordUserId, nickname, gateway, reason }) {
  // Editing a member's displayed name, community-wide. Global scope: it is not tied to
  // one guild or roster.
  authorize(ctx.actor, { capability: 'roster.member', scope: {} });

  const nick = String(nickname ?? '').trim();
  if (!nick) throw new ValidationError('Give a nickname to set.');
  if (nick.length > NICKNAME_MAX) {
    throw new ValidationError(`A Discord nickname is at most ${NICKNAME_MAX} characters (that one is ${nick.length}).`);
  }

  const guilds = await ctx.prisma.approvedGuild.findMany({
    where: { deletedAt: null, enabled: true },
    select: { discordGuildId: true, name: true },
    orderBy: { name: 'asc' },
  });

  const auditReason = reason ?? `Global nickname set by ${ctx.actor?.user?.displayName ?? 'an operator'}`;
  const results = [];

  for (const guild of guilds) {
    try {
      await gateway.setNickname(guild.discordGuildId, discordUserId, nick, auditReason);
      results.push({ guild: guild.name, status: 'applied' });
    } catch (error) {
      // A member the bot cannot reach in one guild must not stop the others.
      let status = 'failed';
      if (error?.issueType === SyncIssueType.MEMBER_NOT_IN_GUILD) status = 'absent';
      else if (error?.issueType === SyncIssueType.GUILD_UNAVAILABLE) status = 'absent';
      results.push({ guild: guild.name, status, message: error?.userMessage ?? error?.message ?? 'failed' });
      if (status === 'failed') {
        log.warn(
          { discordGuildId: guild.discordGuildId, discordUserId, err: serializeError(error) },
          'global nickname write failed in a guild',
        );
      }
    }
  }

  const applied = results.filter((r) => r.status === 'applied').length;

  await recordAudit(ctx.prisma, {
    ctx,
    action: AuditAction.ROSTER_NICKNAME_SET,
    targetDiscordId: discordUserId,
    newState: { nickname: nick, appliedIn: applied, guilds: results },
    reason: auditReason,
  }).catch(() => {});

  return { nickname: nick, total: guilds.length, applied, results };
}
