/**
 * Actor role hierarchy: an operator may never hand out a Discord role that sits at or above
 * their own highest role.
 *
 * The capability gate (`grant.issue`) decides *whether* someone may use the role tools at
 * all; this decides *how high they may reach* with them. Discord's own Manage Roles works
 * exactly this way — you cannot assign a role equal to or above your top role — and a
 * director issuing platform grants should be bound by the same ceiling, so a mid-tier
 * operator can never quietly promote themselves or someone else past their station.
 *
 * The bot's own preflight only proves the *bot* can manage the role; it says nothing about
 * the actor. This is the actor-side check that complements it.
 */
import { RankCeilingError } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';

const log = createLogger('core.role-hierarchy');

/**
 * Throws {@link RankCeilingError} when the actor may not hand out `discordRoleId` because it
 * is at or above the actor's own highest role in that guild. The guild owner is exempt —
 * they sit above every role by definition.
 *
 * Reads the actor's live roles from the gateway rather than trusting anything the caller
 * supplied. If the guild's roles cannot be read at all (a gateway outage), the check is
 * skipped rather than locking everyone out — the downstream add still runs behind the bot's
 * own hierarchy preflight.
 *
 * @param {object} gateway the Discord gateway
 * @param {object} input
 * @param {string} input.discordGuildId the guild the role lives in
 * @param {string|null|undefined} input.actorDiscordUserId the operator running the command
 * @param {string} input.discordRoleId the role being handed out
 */
export async function assertActorAboveRole(
  gateway,
  { discordGuildId, actorDiscordUserId, discordRoleId },
) {
  const actorId = String(actorDiscordUserId ?? '').trim();
  // No resolvable actor (system context, scheduled sweep) — the capability gate already ran
  // and there is no human ceiling to compare against.
  if (!actorId) return;

  let guild = null;
  let targetRole = null;
  let actorMember = null;
  let allRoles = [];
  try {
    [guild, targetRole, actorMember, allRoles] = await Promise.all([
      gateway.getGuild(discordGuildId).catch(() => null),
      gateway.getRole(discordGuildId, discordRoleId).catch(() => null),
      gateway.getMember(discordGuildId, actorDiscordUserId).catch(() => null),
      gateway.listRoles(discordGuildId).catch(() => []),
    ]);
  } catch (error) {
    log.warn(
      { discordGuildId, actorId, discordRoleId, err: serializeError(error) },
      'could not read guild for actor hierarchy check; skipping',
    );
    return;
  }

  // The owner outranks everything.
  if (guild?.ownerId && guild.ownerId === actorId) return;

  // Can't see the guild's roles at all — don't lock the tool out on a read failure.
  if (!Array.isArray(allRoles) || allRoles.length === 0) return;

  // The actor has to actually be in the guild to hold any standing there.
  if (!actorMember) {
    throw new RankCeilingError('You have to be a member of that server to hand out roles in it.');
  }

  const positionById = new Map(allRoles.map((role) => [role.id, role.position]));
  let actorHighest = -1;
  for (const roleId of actorMember.roleIds ?? []) {
    const position = positionById.get(roleId);
    if (typeof position === 'number' && position > actorHighest) actorHighest = position;
  }

  // The role's own position; fall back to the catalogue if a direct fetch missed it.
  const targetPosition =
    typeof targetRole?.position === 'number' ? targetRole.position : positionById.get(discordRoleId);
  // Couldn't place the role — leave it to the downstream add to reject.
  if (typeof targetPosition !== 'number') return;

  if (targetPosition >= actorHighest) {
    throw new RankCeilingError(
      `You can only hand out roles below your own highest role — <@&${discordRoleId}> is at or above it.`,
    );
  }
}
