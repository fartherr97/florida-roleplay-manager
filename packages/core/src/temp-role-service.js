/**
 * Temporary Discord roles: add a role to a member for a set duration, then take it back off.
 *
 * Unlike a managed-role grant, this is a direct, no-strings assignment — the role does not
 * have to be declared managed, and reconciliation never touches it. The role is added
 * immediately in the guild where /temprole was run; a `TempRole` row records the timer, and
 * a maintenance sweep removes the role once the time passes. Running /temprole again for the
 * same member + role supersedes the earlier timer so the sweep never races two removals to
 * one role. Gated at grant.issue; every add and removal is audited and posted to the mod log.
 */
import { authorize } from '@frm/authorization';
import { AuditAction, SyncIssueType, ValidationError, formatDuration } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { recordAudit } from './audit-service.js';
import { notifyModLog } from './notify.js';
import { systemContext } from './context.js';
import { assertActorAboveRole } from './role-hierarchy.js';

const log = createLogger('core.temp-role');

const SNOWFLAKE = /^\d{17,20}$/;
const ADD_COLOR = 0x5865f2;
const REMOVE_COLOR = 0x95a5a6;

function operatorLabel(ctx) {
  const name = ctx.actor?.user?.displayName;
  const id = ctx.actor?.discordUserId;
  if (name && id) return `${name} (<@${id}>)`;
  if (id) return `<@${id}>`;
  return name ?? 'System';
}

/** Turns a gateway error into a short, actionable sentence for the per-guild result. */
function friendlyRoleError(error) {
  if (error?.issueType === SyncIssueType.MEMBER_NOT_IN_GUILD) return 'the member is not in this server';
  if (error?.issueType === SyncIssueType.GUILD_UNAVAILABLE) return 'the bot is not in this server';
  if (error?.issueType === SyncIssueType.BOT_MISSING_PERMISSION) {
    return 'the bot needs Manage Roles and a role above the target role';
  }
  return error?.userMessage ?? error?.message ?? 'failed';
}

/**
 * Adds a Discord role to a member for a set duration in the guild where it was run.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {string} input.discordGuildId guild the command was run in
 * @param {string} [input.guildName] readable guild name, for the record and the log
 * @param {string} input.discordUserId
 * @param {string} input.discordRoleId
 * @param {string} [input.roleName]
 * @param {number|null} input.durationMs how long, in ms; must be a positive finite number
 * @param {string} [input.reason]
 * @param {object} input.gateway the Discord gateway
 */
export async function addTempRole(
  ctx,
  { discordGuildId, guildName, discordUserId, discordRoleId, roleName, durationMs, reason, gateway },
) {
  authorize(ctx.actor, { capability: 'grant.issue', scope: {} });

  const guildId = String(discordGuildId ?? '').trim();
  const userId = String(discordUserId ?? '').trim();
  const roleId = String(discordRoleId ?? '').trim();
  if (!SNOWFLAKE.test(guildId)) throw new ValidationError('This command has to be used inside a server.');
  if (!SNOWFLAKE.test(userId)) throw new ValidationError('That is not a valid Discord user id.');
  if (!SNOWFLAKE.test(roleId)) throw new ValidationError('That is not a valid Discord role id.');
  if (!(Number(durationMs) > 0)) {
    throw new ValidationError('A temporary role needs a duration, e.g. 6h, 7d, 1d12h.');
  }

  const addReason =
    String(reason ?? '').trim() || `Temporary role by ${ctx.actor?.user?.displayName ?? 'an operator'}`;
  const expiresAt = new Date(Date.now() + durationMs);

  // An operator may never hand out a role at or above their own — same ceiling Discord's own
  // Manage Roles enforces. Checked before the add so nothing is written when it is refused.
  await assertActorAboveRole(gateway, {
    discordGuildId: guildId,
    actorDiscordUserId: ctx.actor?.discordUserId,
    discordRoleId: roleId,
  });

  // Add it first — if Discord refuses, we never write a timer for a role that was not applied.
  await gateway.addRole(guildId, userId, roleId, addReason);

  // Supersede any earlier active timer for this same member + role in this guild so the sweep
  // only ever has one row to act on.
  await ctx.prisma.tempRole
    .updateMany({
      where: { discordGuildId: guildId, discordUserId: userId, discordRoleId: roleId, active: true },
      data: { active: false, removedAt: new Date(), removedReason: 'superseded' },
    })
    .catch(() => {});

  const record = await ctx.prisma.tempRole
    .create({
      data: {
        discordGuildId: guildId,
        guildName: guildName ?? null,
        discordUserId: userId,
        discordRoleId: roleId,
        roleName: roleName ?? null,
        reason: addReason,
        addedByLabel: operatorLabel(ctx),
        addedById: ctx.actor?.user?.id ?? null,
        expiresAt,
      },
    })
    .catch((error) => {
      log.error({ err: serializeError(error) }, 'failed to record temp role');
      return null;
    });

  await recordAudit(ctx.prisma, {
    ctx,
    action: AuditAction.MEMBER_ROLE_TEMP_ADDED,
    targetDiscordId: userId,
    newState: {
      discordGuildId: guildId,
      discordRoleId: roleId,
      roleName: roleName ?? null,
      reason: addReason,
      expiresAt: expiresAt.toISOString(),
    },
    reason: addReason,
  }).catch(() => {});

  await notifyModLog({
    category: 'temp_role',
    title: 'Temporary role added',
    description: `<@&${roleId}> was given to <@${userId}> (\`${userId}\`) in **${guildName ?? guildId}**.`,
    color: ADD_COLOR,
    fields: [
      { name: 'Operator', value: operatorLabel(ctx), inline: true },
      { name: 'Duration', value: formatDuration(durationMs), inline: true },
      { name: 'Expires', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`, inline: true },
      { name: 'Reason', value: addReason },
    ],
  }).catch(() => {});

  return { id: record?.id ?? null, discordUserId: userId, discordRoleId: roleId, expiresAt };
}

/**
 * Removes a member's temporary role early, cancelling its pending timer.
 *
 * A no-op-ish removal (the role was already gone) is not an error — the timer is closed
 * either way. Returns whether a live timer was found.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {string} input.discordGuildId
 * @param {string} [input.guildName]
 * @param {string} input.discordUserId
 * @param {string} input.discordRoleId
 * @param {string} [input.reason]
 * @param {object} input.gateway
 */
export async function removeTempRole(
  ctx,
  { discordGuildId, guildName, discordUserId, discordRoleId, reason, gateway },
) {
  authorize(ctx.actor, { capability: 'grant.issue', scope: {} });

  const guildId = String(discordGuildId ?? '').trim();
  const userId = String(discordUserId ?? '').trim();
  const roleId = String(discordRoleId ?? '').trim();
  if (!SNOWFLAKE.test(guildId)) throw new ValidationError('This command has to be used inside a server.');
  if (!SNOWFLAKE.test(userId)) throw new ValidationError('That is not a valid Discord user id.');
  if (!SNOWFLAKE.test(roleId)) throw new ValidationError('That is not a valid Discord role id.');

  const removeReason =
    String(reason ?? '').trim() || `Temporary role removed by ${ctx.actor?.user?.displayName ?? 'an operator'}`;

  const closed = await ctx.prisma.tempRole.updateMany({
    where: { discordGuildId: guildId, discordUserId: userId, discordRoleId: roleId, active: true },
    data: { active: false, removedAt: new Date(), removedReason: 'manual' },
  });

  // Take the role back off. A member who already lost the role is fine; report a real failure.
  let applied = true;
  let failure = null;
  try {
    await gateway.removeRole(guildId, userId, roleId, removeReason);
  } catch (error) {
    if (error?.issueType === SyncIssueType.MEMBER_NOT_IN_GUILD) {
      applied = false; // gone from the server — nothing to remove
    } else {
      applied = false;
      failure = friendlyRoleError(error);
      log.warn({ guildId, userId, roleId, err: serializeError(error) }, 'temp role manual removal failed');
    }
  }

  await recordAudit(ctx.prisma, {
    ctx,
    action: AuditAction.MEMBER_ROLE_TEMP_REMOVED,
    targetDiscordId: userId,
    newState: { discordGuildId: guildId, discordRoleId: roleId, manual: true, applied },
    reason: removeReason,
  }).catch(() => {});

  await notifyModLog({
    category: 'temp_role',
    title: 'Temporary role removed',
    description: `<@&${roleId}> was taken from <@${userId}> (\`${userId}\`) in **${guildName ?? guildId}**.`,
    color: REMOVE_COLOR,
    fields: [
      { name: 'Operator', value: operatorLabel(ctx), inline: true },
      { name: 'Reason', value: removeReason },
      ...(failure ? [{ name: 'Note', value: failure }] : []),
    ],
  }).catch(() => {});

  return { found: closed.count > 0, applied, failure };
}

/**
 * The maintenance sweep: take back every temporary role whose time has passed.
 *
 * Each row carries its own guild, member and role, so the sweep is self-contained. Best
 * effort per row — a member who already left, or a guild the bot cannot reach, closes the
 * timer without a fuss — and idempotent: a row is flipped inactive as soon as it is swept.
 *
 * @param {{gateway: object, prisma: object}} deps
 */
export async function runTempRoleExpiry({ gateway, prisma }) {
  const now = new Date();
  const due = await prisma.tempRole.findMany({
    where: { active: true, expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: 50,
  });
  if (due.length === 0) return { expired: 0 };

  const ctx = systemContext({ scheduled: true, label: 'temp-role-expiry' });

  for (const temp of due) {
    let note = null;
    try {
      await gateway.removeRole(temp.discordGuildId, temp.discordUserId, temp.discordRoleId, 'Temporary role expired');
    } catch (error) {
      note = friendlyRoleError(error);
      // MEMBER_NOT_IN_GUILD / GUILD_UNAVAILABLE just mean there is nothing to take off.
      const benign =
        error?.issueType === SyncIssueType.MEMBER_NOT_IN_GUILD ||
        error?.issueType === SyncIssueType.GUILD_UNAVAILABLE;
      if (!benign) {
        log.warn(
          { id: temp.id, guildId: temp.discordGuildId, err: serializeError(error) },
          'temp role expiry removal failed',
        );
      }
    }

    await prisma.tempRole
      .update({ where: { id: temp.id }, data: { active: false, removedAt: now, removedReason: 'expired' } })
      .catch((error) => log.error({ err: serializeError(error), id: temp.id }, 'failed to close temp role'));

    await recordAudit(prisma, {
      ctx,
      action: AuditAction.MEMBER_ROLE_TEMP_REMOVED,
      targetDiscordId: temp.discordUserId,
      newState: { discordGuildId: temp.discordGuildId, discordRoleId: temp.discordRoleId, expired: true },
      reason: 'Temporary role expired',
    }).catch(() => {});

    await notifyModLog({
      category: 'temp_role',
      title: 'Temporary role expired',
      description: `<@&${temp.discordRoleId}>'s time on <@${temp.discordUserId}> (\`${temp.discordUserId}\`) expired in **${temp.guildName ?? temp.discordGuildId}** and was taken back off.`,
      color: REMOVE_COLOR,
      fields: [
        { name: 'Original reason', value: temp.reason ?? '—' },
        ...(note ? [{ name: 'Note', value: note }] : []),
      ],
    }).catch(() => {});
  }

  log.info({ expired: due.length }, 'temp roles swept');
  return { expired: due.length };
}
