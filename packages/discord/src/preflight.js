/**
 * Pre-flight validation for role operations.
 *
 * Every single role write is checked here first. The checks are the ones that actually
 * fail in production, in the order the specification lists them:
 *
 *   1. the bot is in the guild and the guild is available
 *   2. the target member is in the guild
 *   3. the role exists
 *   4. the role is not @everyone
 *   5. the role is not managed by another integration
 *   6. the bot has Manage Roles
 *   7. the bot's highest role is above the role being changed
 *   8. the role is not protected (unless the caller is explicitly allowed)
 *
 * Results are returned rather than thrown so the worker can record one `SyncIssue` per
 * failed action and carry on with the rest of the plan.
 */
import {
  IssueSeverity,
  ProtectedRoleError,
  ProtectionLevel,
  RoleHierarchyError,
  SyncIssueType,
} from '@frm/shared';

/**
 * @typedef {object} PreflightResult
 * @property {boolean} ok
 * @property {string} [issueType]
 * @property {string} [severity]
 * @property {string} [message]
 * @property {boolean} [retryable]
 */

const OK = Object.freeze({ ok: true });

function fail(issueType, message, { retryable = false, severity = IssueSeverity.ERROR } = {}) {
  return { ok: false, issueType, message, retryable, severity };
}

/**
 * Validates a single planned role change against live Discord state.
 *
 * @param {object} gateway role gateway
 * @param {object} params
 * @param {string} params.discordGuildId
 * @param {string} params.discordUserId
 * @param {string} params.discordRoleId
 * @param {string} [params.protectionLevel] protection recorded for the managed role
 * @param {boolean} [params.allowProtected] caller has elevated authorization
 * @returns {Promise<PreflightResult>}
 */
export async function checkRoleOperation(gateway, params) {
  const {
    discordGuildId,
    discordUserId,
    discordRoleId,
    protectionLevel = ProtectionLevel.NONE,
    allowProtected = false,
  } = params;

  const guild = await gateway.getGuild(discordGuildId);
  if (!guild) {
    return fail(SyncIssueType.BOT_NOT_IN_GUILD, 'The bot is not a member of that Discord server.');
  }
  if (!guild.available) {
    return fail(SyncIssueType.GUILD_UNAVAILABLE, 'That Discord server is currently unavailable.', {
      retryable: true,
    });
  }
  if (!guild.botPresent) {
    return fail(SyncIssueType.BOT_NOT_IN_GUILD, 'The bot is not a member of that Discord server.');
  }
  if (!guild.botCanManageRoles) {
    return fail(
      SyncIssueType.BOT_MISSING_PERMISSION,
      'The bot does not have the Manage Roles permission in that server.',
    );
  }

  const member = await gateway.getMember(discordGuildId, discordUserId);
  if (!member) {
    return fail(
      SyncIssueType.MEMBER_NOT_IN_GUILD,
      'That member is not in the Discord server, so their roles cannot be changed there.',
      { severity: IssueSeverity.WARNING },
    );
  }

  const role = await gateway.getRole(discordGuildId, discordRoleId);
  if (!role) {
    return fail(
      SyncIssueType.ROLE_DELETED,
      'That Discord role no longer exists. Update the mapping or the managed role definition.',
    );
  }
  if (role.isEveryone) {
    return fail(
      SyncIssueType.INVALID_ROLE_REFERENCE,
      'The @everyone role can never be added or removed.',
    );
  }
  if (role.managed) {
    return fail(
      SyncIssueType.INTEGRATION_MANAGED_ROLE,
      `"${role.name}" is managed by another integration (a bot, booster or subscription role) and cannot be changed.`,
    );
  }
  if (role.position >= guild.botHighestRolePosition) {
    return fail(
      SyncIssueType.ROLE_ABOVE_BOT,
      `"${role.name}" sits above the bot's highest role. Move the bot's role higher in Server Settings > Roles.`,
    );
  }
  if (protectionLevel !== ProtectionLevel.NONE && !allowProtected) {
    return fail(
      SyncIssueType.PROTECTED_ROLE_VIOLATION,
      `"${role.name}" is a protected role and requires elevated authorization.`,
    );
  }

  return OK;
}

/**
 * Validates a planned nickname rewrite against live Discord state.
 *
 * Renaming has its own hierarchy rule, and it is not the one role writes use. Discord
 * refuses to let any bot rename the **guild owner** - no permission unlocks it - and
 * refuses to rename a member whose own highest role is at or above the bot's. Both come
 * back as a bare 50013 that reads as "missing permission", which sends an administrator
 * looking in the wrong place. Checking first turns them into an instruction.
 *
 * @param {object} gateway
 * @param {object} params
 * @param {string} params.discordGuildId
 * @param {string} params.discordUserId
 * @returns {Promise<PreflightResult>}
 */
export async function checkNicknameOperation(gateway, { discordGuildId, discordUserId }) {
  const guild = await gateway.getGuild(discordGuildId);
  if (!guild) {
    return fail(SyncIssueType.BOT_NOT_IN_GUILD, 'The bot is not a member of that Discord server.');
  }
  if (!guild.available) {
    return fail(SyncIssueType.GUILD_UNAVAILABLE, 'That Discord server is currently unavailable.', {
      retryable: true,
    });
  }
  if (!guild.botPresent) {
    return fail(SyncIssueType.BOT_NOT_IN_GUILD, 'The bot is not a member of that Discord server.');
  }
  if (guild.botCanManageNicknames === false) {
    return fail(
      SyncIssueType.BOT_MISSING_PERMISSION,
      'The bot does not have the Manage Nicknames permission in that server.',
    );
  }

  const member = await gateway.getMember(discordGuildId, discordUserId);
  if (!member) {
    return fail(
      SyncIssueType.MEMBER_NOT_IN_GUILD,
      'That member is not in the Discord server, so their nickname cannot be changed there.',
      { severity: IssueSeverity.WARNING },
    );
  }
  if (member.isOwner || guild.ownerId === discordUserId) {
    return fail(
      SyncIssueType.MEMBER_ABOVE_BOT,
      'Discord does not allow any bot to rename the server owner. Set their nickname by hand; ' +
        'their roster entry is still correct.',
      { severity: IssueSeverity.WARNING },
    );
  }
  if (
    typeof member.highestRolePosition === 'number' &&
    typeof guild.botHighestRolePosition === 'number' &&
    member.highestRolePosition >= guild.botHighestRolePosition
  ) {
    return fail(
      SyncIssueType.MEMBER_ABOVE_BOT,
      "That member's highest role is at or above the bot's, so Discord will not let the bot " +
        "rename them. Move the bot's role higher in Server Settings > Roles.",
    );
  }

  return OK;
}

/**
 * Validates that a role may participate in a mapping.
 *
 * This runs when a mapping is created or enabled, where the caller is a human waiting
 * for an answer, so failures throw with an explanation instead of being recorded.
 *
 * @param {object} gateway
 * @param {object} params
 * @param {string} params.discordGuildId
 * @param {string} params.discordRoleId
 * @param {string} params.side 'source' or 'target'
 * @param {string} [params.protectionLevel]
 * @param {boolean} [params.allowProtected]
 */
export async function assertRoleMappable(gateway, params) {
  const {
    discordGuildId,
    discordRoleId,
    side,
    protectionLevel = ProtectionLevel.NONE,
    allowProtected = false,
  } = params;

  const guild = await gateway.getGuild(discordGuildId);
  if (!guild || !guild.botPresent) {
    throw new RoleHierarchyError(
      `The bot is not in the ${side} Discord server, so it cannot manage roles there.`,
      { discordGuildId, side },
    );
  }
  if (!guild.botCanManageRoles) {
    throw new RoleHierarchyError(
      `The bot is missing the Manage Roles permission in the ${side} server.`,
      { discordGuildId, side },
    );
  }

  const role = await gateway.getRole(discordGuildId, discordRoleId);
  if (!role) {
    throw new RoleHierarchyError(`The ${side} role does not exist in that server.`, {
      discordGuildId,
      discordRoleId,
      side,
    });
  }
  if (role.isEveryone) {
    throw new RoleHierarchyError(`The @everyone role cannot be used as a ${side} role.`, {
      side,
    });
  }
  if (role.managed) {
    throw new ProtectedRoleError(
      `"${role.name}" is managed by another integration and cannot be mapped.`,
      { discordGuildId, discordRoleId, side },
    );
  }
  if (role.position >= guild.botHighestRolePosition) {
    throw new RoleHierarchyError(
      `"${role.name}" is above the bot's highest role in the ${side} server. ` +
        "Move the bot's role above it and try again.",
      {
        discordGuildId,
        discordRoleId,
        side,
        rolePosition: role.position,
        botPosition: guild.botHighestRolePosition,
      },
    );
  }
  if (protectionLevel === ProtectionLevel.ELEVATED && !allowProtected) {
    throw new ProtectedRoleError(
      `"${role.name}" is a protected role. Mapping it requires elevated authorization.`,
      { discordGuildId, discordRoleId, side },
    );
  }

  return role;
}
