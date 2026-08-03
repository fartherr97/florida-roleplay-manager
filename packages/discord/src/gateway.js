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
 * @property {number} botHighestRolePosition
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
import { PermissionFlagsBits } from 'discord.js';
import { mapDiscordError } from './errors.js';

const log = createLogger('discord.gateway');

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

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    return {
      id: guild.id,
      name: guild.name,
      available: guild.available !== false,
      botPresent: Boolean(me),
      botCanManageRoles: Boolean(me?.permissions.has(PermissionFlagsBits.ManageRoles)),
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

  async leaveGuild(discordGuildId) {
    log.info({ discordGuildId }, 'mock: would leave guild');
    return false;
  }
}
