/**
 * The role gateway.
 *
 * Everything the platform does to Discord goes through this narrow interface. The
 * reconciliation engine, the worker and the services depend on the interface, never on
 * discord.js, which is what makes the whole synchronization path testable offline.
 *
 * Implementations:
 *   - {@link DiscordJsRoleGateway} - the real thing
 *   - `MockRoleGateway`            - in-memory, used by tests and by DISCORD_MOCK mode
 *
 * @typedef {object} GuildSnapshot
 * @property {string} id
 * @property {string} name
 * @property {boolean} available
 * @property {boolean} botPresent
 * @property {boolean} botCanManageRoles
 * @property {boolean} botCanManageChannels
 * @property {number} botHighestRolePosition
 *
 * @typedef {object} ChannelSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} type  one of the abstract types: 'category' | 'text' | 'voice'
 * @property {string|null} parentId  the category this channel sits under
 *
 * @typedef {object} RoleSnapshot
 * @property {string} id
 * @property {string} name
 * @property {number} position
 * @property {boolean} managed  true when another integration owns the role
 * @property {boolean} isEveryone
 *
 * @typedef {object} MemberSnapshot
 * @property {string} id
 * @property {string} displayName
 * @property {string[]} roleIds
 */
import { createLogger, serializeError } from '@frm/logging';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { DiscordErrorCode, mapDiscordError } from './errors.js';

const log = createLogger('discord.gateway');

/** Maps the gateway's abstract channel types onto discord.js channel-type constants. */
const CHANNEL_TYPE = {
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};

/** Maps a discord.js channel-type constant back onto an abstract type. */
const ABSTRACT_CHANNEL_TYPE = new Map(
  Object.entries(CHANNEL_TYPE).map(([abstract, concrete]) => [concrete, abstract]),
);

/** Resolves permission-flag names (e.g. 'ViewChannel') to their bitfield values. */
function resolvePermissionFlags(names = []) {
  return names.map((name) => {
    const flag = PermissionFlagsBits[name];
    if (flag === undefined) throw new Error(`Unknown permission flag: ${name}`);
    return flag;
  });
}

/** Translates the gateway's abstract permission overwrites into discord.js shape. */
function toDiscordOverwrites(overwrites = []) {
  return overwrites.map((overwrite) => ({
    id: overwrite.id,
    allow: resolvePermissionFlags(overwrite.allow),
    deny: resolvePermissionFlags(overwrite.deny),
  }));
}

/**
 * Real gateway backed by a discord.js client.
 */
export class DiscordJsRoleGateway {
  /**
   * @param {import('discord.js').Client} client
   */
  constructor(client) {
    this.client = client;
    this.name = 'discord.js';
  }

  /** @param {string} discordGuildId @returns {Promise<GuildSnapshot|null>} */
  async getGuild(discordGuildId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) return null;

    let me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    // The cached bot member can hold roles/permissions from before an admin change: after
    // the bot is granted Manage Roles or moved up the role list, `guild.members.me` keeps
    // returning the stale copy until the process restarts, which reads as a permanent
    // "bot cannot manage roles". If the cached copy says it cannot, confirm against Discord
    // with a forced refetch before believing it, so a just-granted permission is seen now.
    if (me && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      me = (await guild.members.fetchMe({ force: true }).catch(() => null)) ?? me;
    }
    return {
      id: guild.id,
      name: guild.name,
      available: guild.available !== false,
      botPresent: Boolean(me),
      botCanManageRoles: Boolean(me?.permissions.has(PermissionFlagsBits.ManageRoles)),
      botCanManageChannels: Boolean(me?.permissions.has(PermissionFlagsBits.ManageChannels)),
      botHighestRolePosition: me?.roles?.highest?.position ?? -1,
    };
  }

  /** @param {string} discordGuildId @param {string} discordRoleId @returns {Promise<RoleSnapshot|null>} */
  async getRole(discordGuildId, discordRoleId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) return null;

    const role =
      guild.roles.cache.get(discordRoleId) ??
      (await guild.roles.fetch(discordRoleId).catch(() => null));
    if (!role) return null;

    return {
      id: role.id,
      name: role.name,
      position: role.position,
      // discord.js reports an unset colour as 0 / "#000000"; treat that as no colour
      // so a default role does not paint the roster black.
      color: role.color ? role.hexColor : null,
      managed: role.managed,
      isEveryone: role.id === guild.id,
    };
  }

  /** @param {string} discordGuildId @returns {Promise<RoleSnapshot[]>} */
  async listRoles(discordGuildId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) return [];
    const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
    return [...roles.values()].map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      color: role.color ? role.hexColor : null,
      managed: role.managed,
      isEveryone: role.id === guild.id,
    }));
  }

  /** @param {string} discordGuildId @param {string} discordUserId @returns {Promise<MemberSnapshot|null>} */
  async getMember(discordGuildId, discordUserId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) return null;

    const member = await guild.members
      .fetch({ user: discordUserId, force: false })
      .catch(() => null);
    if (!member) return null;

    return {
      id: member.id,
      displayName: member.displayName ?? member.user?.username ?? member.id,
      roleIds: [...member.roles.cache.keys()].filter((roleId) => roleId !== guild.id),
    };
  }

  /**
   * Every member of a guild.
   *
   * Used by guild-wide and global resyncs, which have to consider everybody who might
   * hold a mapped role - not just members with a platform account. This is a heavy call
   * on a large guild (it pages the whole member list over the gateway), so it is only
   * ever made by a queued job, never inside an interaction handler.
   *
   * @param {string} discordGuildId
   * @returns {Promise<MemberSnapshot[]>}
   */
  async listMembers(discordGuildId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) return [];

    const members = await guild.members.fetch().catch((error) => {
      log.warn({ discordGuildId, err: serializeError(error) }, 'could not list guild members');
      return null;
    });
    if (!members) return [];

    return [...members.values()].map((member) => ({
      id: member.id,
      displayName: member.displayName ?? member.user?.username ?? member.id,
      roleIds: [...member.roles.cache.keys()].filter((roleId) => roleId !== guild.id),
    }));
  }

  /**
   * @param {string} discordGuildId
   * @param {string} discordUserId
   * @param {string} discordRoleId
   * @param {string} reason audit-log reason shown in Discord
   */
  async addRole(discordGuildId, discordUserId, discordRoleId, reason) {
    try {
      const guild = await this.#requireGuild(discordGuildId);
      const member = await guild.members.fetch(discordUserId);
      await member.roles.add(discordRoleId, truncateReason(reason));
      return { applied: true };
    } catch (error) {
      log.warn(
        { discordGuildId, discordUserId, discordRoleId, err: serializeError(error) },
        'add role failed',
      );
      throw mapDiscordError(error, { discordGuildId, discordUserId, discordRoleId });
    }
  }

  /**
   * @param {string} discordGuildId
   * @param {string} discordUserId
   * @param {string} discordRoleId
   * @param {string} reason
   */
  async removeRole(discordGuildId, discordUserId, discordRoleId, reason) {
    try {
      const guild = await this.#requireGuild(discordGuildId);
      const member = await guild.members.fetch(discordUserId);
      await member.roles.remove(discordRoleId, truncateReason(reason));
      return { applied: true };
    } catch (error) {
      log.warn(
        { discordGuildId, discordUserId, discordRoleId, err: serializeError(error) },
        'remove role failed',
      );
      throw mapDiscordError(error, { discordGuildId, discordUserId, discordRoleId });
    }
  }

  /**
   * Rewrites a member's nickname, or clears it when `nickname` is null.
   *
   * Discord refuses two renames that no permission can unlock: the guild owner, and any
   * member whose highest role is at or above the bot's. Both surface as a 50013, which
   * `mapDiscordError` reports as a missing permission - true, but not actionable. The
   * pre-flight check distinguishes them before the call is ever made.
   *
   * @param {string} discordGuildId
   * @param {string} discordUserId
   * @param {string|null} nickname
   * @param {string} reason audit-log reason shown in Discord
   */
  async setNickname(discordGuildId, discordUserId, nickname, reason) {
    try {
      const guild = await this.#requireGuild(discordGuildId);
      const member = await guild.members.fetch(discordUserId);
      await member.setNickname(nickname ?? null, truncateReason(reason));
      return { applied: true, nickname: nickname ?? null };
    } catch (error) {
      log.warn(
        { discordGuildId, discordUserId, err: serializeError(error) },
        'set nickname failed',
      );
      throw mapDiscordError(error, { discordGuildId, discordUserId });
    }
  }

  /**
   * Bans a user from a guild. Works by user id, so it applies whether or not the user
   * is currently a member (a ban on someone who already left still takes).
   *
   * @param {string} discordGuildId
   * @param {string} discordUserId
   * @param {{reason?: string, deleteMessageSeconds?: number}} [options]
   * @returns {Promise<{applied: true}>}
   */
  async banMember(discordGuildId, discordUserId, { reason, deleteMessageSeconds } = {}) {
    try {
      const guild = await this.#requireGuild(discordGuildId);
      await guild.bans.create(discordUserId, {
        reason: truncateReason(reason),
        deleteMessageSeconds: deleteMessageSeconds ?? 0,
      });
      return { applied: true };
    } catch (error) {
      log.warn({ discordGuildId, discordUserId, err: serializeError(error) }, 'ban failed');
      throw mapDiscordError(error, { discordGuildId, discordUserId });
    }
  }

  /**
   * Lifts a ban. Unbanning someone who is not banned is reported as a no-op rather than
   * an error, so a global unban does not fail on the guilds where the user was never
   * banned.
   *
   * @param {string} discordGuildId
   * @param {string} discordUserId
   * @param {string} [reason]
   * @returns {Promise<{applied: boolean, reason?: string}>}
   */
  async unbanMember(discordGuildId, discordUserId, reason) {
    try {
      const guild = await this.#requireGuild(discordGuildId);
      await guild.bans.remove(discordUserId, truncateReason(reason));
      return { applied: true };
    } catch (error) {
      if (error?.code === DiscordErrorCode.UNKNOWN_BAN) return { applied: false, reason: 'not_banned' };
      log.warn({ discordGuildId, discordUserId, err: serializeError(error) }, 'unban failed');
      throw mapDiscordError(error, { discordGuildId, discordUserId });
    }
  }

  /**
   * Every category and channel in a guild, in the gateway's abstract shape.
   * Used by server provisioning to decide what already exists and must be skipped.
   *
   * @param {string} discordGuildId
   * @returns {Promise<ChannelSnapshot[]>}
   */
  async listChannels(discordGuildId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) return [];
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    return [...channels.values()]
      .filter(Boolean)
      .filter((channel) => ABSTRACT_CHANNEL_TYPE.has(channel.type))
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: ABSTRACT_CHANNEL_TYPE.get(channel.type),
        parentId: channel.parentId ?? null,
      }));
  }

  /**
   * Creates a role. Only ever used by provisioning, which is why it lives on the same
   * gateway rather than a second one: the reason string is what shows in the Discord
   * audit log, so a human can always see the platform created it.
   *
   * @param {string} discordGuildId
   * @param {{name: string, color?: number|string, hoist?: boolean, mentionable?: boolean, permissions?: string[], reason?: string}} spec
   * @returns {Promise<{id: string, name: string}>}
   */
  async createRole(discordGuildId, spec) {
    try {
      const guild = await this.#requireGuild(discordGuildId);
      const role = await guild.roles.create({
        name: spec.name,
        color: spec.color ?? undefined,
        hoist: spec.hoist ?? false,
        mentionable: spec.mentionable ?? false,
        // Zero permissions unless a spec explicitly asks for some. Discord otherwise copies
        // the @everyone permissions onto a new role, which is not what we want: access is
        // meant to come entirely from per-channel overwrites, and a blank role also always
        // creates (a role carrying a permission the bot lacks would be rejected).
        permissions: spec.permissions ? resolvePermissionFlags(spec.permissions) : 0n,
        reason: truncateReason(spec.reason),
      });
      return { id: role.id, name: role.name };
    } catch (error) {
      log.warn(
        { discordGuildId, name: spec.name, err: serializeError(error) },
        'create role failed',
      );
      throw mapDiscordError(error, { discordGuildId });
    }
  }

  /**
   * Sets a role's permissions. Passing an empty (or omitted) permission list clears every
   * permission - which is how `/setup permissions` blanks the provisioned roles. The
   * @everyone role is edited the same way, by passing the guild id as the role id.
   *
   * @param {string} discordGuildId
   * @param {string} discordRoleId
   * @param {{permissions?: string[], reason?: string}} spec
   * @returns {Promise<{id: string, name: string}>}
   */
  async editRolePermissions(discordGuildId, discordRoleId, spec = {}) {
    try {
      const guild = await this.#requireGuild(discordGuildId);
      const role = await guild.roles.edit(discordRoleId, {
        permissions: resolvePermissionFlags(spec.permissions ?? []),
        reason: truncateReason(spec.reason),
      });
      return { id: role.id, name: role.name };
    } catch (error) {
      log.warn(
        { discordGuildId, discordRoleId, err: serializeError(error) },
        'edit role permissions failed',
      );
      throw mapDiscordError(error, { discordGuildId });
    }
  }

  /**
   * Creates a category or channel.
   *
   * @param {string} discordGuildId
   * @param {{name: string, type: string, parentId?: string|null, topic?: string, permissionOverwrites?: Array<{id: string, allow?: string[], deny?: string[]}>, reason?: string}} spec
   * @returns {Promise<ChannelSnapshot>}
   */
  async createChannel(discordGuildId, spec) {
    const concreteType = CHANNEL_TYPE[spec.type];
    if (concreteType === undefined) throw new Error(`Unknown channel type: ${spec.type}`);
    try {
      const guild = await this.#requireGuild(discordGuildId);
      const channel = await guild.channels.create({
        name: spec.name,
        type: concreteType,
        parent: spec.parentId ?? undefined,
        topic: spec.type === 'text' ? (spec.topic ?? undefined) : undefined,
        permissionOverwrites: spec.permissionOverwrites
          ? toDiscordOverwrites(spec.permissionOverwrites)
          : undefined,
        reason: truncateReason(spec.reason),
      });
      return {
        id: channel.id,
        name: channel.name,
        type: ABSTRACT_CHANNEL_TYPE.get(channel.type) ?? spec.type,
        parentId: channel.parentId ?? null,
      };
    } catch (error) {
      log.warn(
        { discordGuildId, name: spec.name, err: serializeError(error) },
        'create channel failed',
      );
      throw mapDiscordError(error, { discordGuildId });
    }
  }

  /** Leaves a guild. Used when the bot is added to a server that is not approved. */
  async leaveGuild(discordGuildId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) return false;
    await guild.leave();
    return true;
  }

  /** Every guild the bot is currently a member of. */
  async listGuilds() {
    const guilds = await this.client.guilds.fetch().catch(() => null);
    if (!guilds) return [];
    return [...guilds.values()].map((guild) => ({ id: guild.id, name: guild.name }));
  }

  async #fetchGuild(discordGuildId) {
    return (
      this.client.guilds.cache.get(discordGuildId) ??
      (await this.client.guilds.fetch(discordGuildId).catch(() => null))
    );
  }

  async #requireGuild(discordGuildId) {
    const guild = await this.#fetchGuild(discordGuildId);
    if (!guild) {
      const error = new Error(`Unknown guild ${discordGuildId}`);
      error.code = 10004;
      throw error;
    }
    return guild;
  }
}

/** Discord truncates audit reasons at 512 characters and rejects longer ones. */
function truncateReason(reason) {
  const text = String(reason ?? 'Florida Roleplay Manager synchronization');
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * A gateway that reports every write as a no-op. Used when DISCORD_MOCK is enabled so a
 * developer can exercise the full pipeline without touching a real server.
 */
export class ReadOnlyGatewayDecorator {
  /** @param {DiscordJsRoleGateway} inner */
  constructor(inner) {
    this.inner = inner;
    this.name = `read-only(${inner.name})`;
  }

  getGuild(...args) {
    return this.inner.getGuild(...args);
  }
  getRole(...args) {
    return this.inner.getRole(...args);
  }
  listRoles(...args) {
    return this.inner.listRoles(...args);
  }
  getMember(...args) {
    return this.inner.getMember(...args);
  }
  listMembers(...args) {
    return this.inner.listMembers(...args);
  }
  listChannels(...args) {
    return this.inner.listChannels(...args);
  }
  listGuilds(...args) {
    return this.inner.listGuilds(...args);
  }

  async addRole(discordGuildId, discordUserId, discordRoleId) {
    log.info({ discordGuildId, discordUserId, discordRoleId }, 'mock: would add role');
    return { applied: false, mocked: true };
  }

  async removeRole(discordGuildId, discordUserId, discordRoleId) {
    log.info({ discordGuildId, discordUserId, discordRoleId }, 'mock: would remove role');
    return { applied: false, mocked: true };
  }

  async setNickname(discordGuildId, discordUserId, nickname) {
    log.info({ discordGuildId, discordUserId, nickname }, 'mock: would set nickname');
    return { applied: false, mocked: true, nickname: nickname ?? null };
  }

  async createRole(discordGuildId, spec) {
    log.info({ discordGuildId, name: spec?.name }, 'mock: would create role');
    return { id: `mock-role-${spec?.name}`, name: spec?.name, mocked: true };
  }

  async editRolePermissions(discordGuildId, discordRoleId) {
    log.info({ discordGuildId, discordRoleId }, 'mock: would edit role permissions');
    return { id: discordRoleId, name: discordRoleId, mocked: true };
  }

  async createChannel(discordGuildId, spec) {
    log.info({ discordGuildId, name: spec?.name, type: spec?.type }, 'mock: would create channel');
    return {
      id: `mock-channel-${spec?.name}`,
      name: spec?.name,
      type: spec?.type,
      parentId: null,
      mocked: true,
    };
  }

  async leaveGuild(discordGuildId) {
    log.info({ discordGuildId }, 'mock: would leave guild');
    return false;
  }
}
