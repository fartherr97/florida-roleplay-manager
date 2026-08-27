/**
 * A read-only gateway backed by Discord's REST API rather than a live connection.
 *
 * The API process holds no gateway: the bot observes and the worker writes, and giving
 * the API its own connection would mean a third process with an opinion about Discord's
 * state (see role-catalog.js). But enabling and testing a role mapping needs live role
 * checks — does the role exist, is it above the bot, can the bot manage roles — and those
 * are all plain REST reads. This gateway answers exactly the read methods the mapping
 * validation calls (`getGuild`, `getRole`, `listRoles`) over REST with the bot token, and
 * nothing else. It never writes, so the rule that the worker is the only writer stands.
 *
 * A tiny per-guild cache collapses the handful of reads a single validate pass makes (it
 * asks for the guild and a role on each side) into one fetch of each underlying resource.
 */
import { PermissionFlagsBits, REST, Routes } from 'discord.js';
import { createLogger, serializeError } from '@frm/logging';
import { mapDiscordError } from './errors.js';

const log = createLogger('discord.rest-gateway');

const ADMINISTRATOR = PermissionFlagsBits.Administrator;
const MANAGE_ROLES = PermissionFlagsBits.ManageRoles;
const CACHE_TTL_MS = 10_000;

export class RestRoleGateway {
  #rest;
  #applicationId;
  #ttlMs;
  /** @type {Map<string, {expiresAt: number, promise: Promise<object>}>} */
  #cache = new Map();

  /**
   * @param {object} params
   * @param {string} [params.token] bot token; ignored when `rest` is supplied
   * @param {string} [params.applicationId] the bot's application id (also its user id)
   * @param {number} [params.ttlMs]
   * @param {object} [params.rest] an injected REST-alike, for tests
   */
  constructor({ token, applicationId, ttlMs = CACHE_TTL_MS, rest } = {}) {
    this.#rest = rest ?? new REST({ version: '10', timeout: 10_000 }).setToken(token);
    this.#applicationId = applicationId;
    this.#ttlMs = ttlMs;
    this.name = 'discord.rest';
  }

  /** Fetches (and briefly caches) the raw roles, bot member and guild for one guild. */
  async #snapshot(discordGuildId) {
    const cached = this.#cache.get(discordGuildId);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const promise = this.#fetch(discordGuildId).catch((error) => {
      this.#cache.delete(discordGuildId);
      throw error;
    });
    this.#cache.set(discordGuildId, { expiresAt: Date.now() + this.#ttlMs, promise });
    return promise;
  }

  async #fetch(discordGuildId) {
    let roles;
    try {
      roles = await this.#rest.get(Routes.guildRoles(discordGuildId));
    } catch (error) {
      log.error({ err: serializeError(error), discordGuildId }, 'could not list roles for guild');
      throw mapDiscordError(error, { discordGuildId });
    }

    // The bot member and the guild let us decide presence, hierarchy and Manage Roles.
    // Neither is fatal to reading roles, so a failure degrades to "not present / cannot
    // manage" rather than throwing — the mapping simply will not enable, which is correct.
    let member = null;
    let guild = null;
    if (this.#applicationId) {
      [member, guild] = await Promise.all([
        this.#rest.get(Routes.guildMember(discordGuildId, this.#applicationId)).catch((error) => {
          log.warn({ err: serializeError(error), discordGuildId }, 'could not read the bot member');
          return null;
        }),
        this.#rest.get(Routes.guild(discordGuildId)).catch(() => null),
      ]);
    }

    return { roles, member, guild };
  }

  /** @param {string} discordGuildId */
  async getGuild(discordGuildId) {
    const { roles, member, guild } = await this.#snapshot(discordGuildId);
    if (!member) {
      return {
        id: discordGuildId,
        name: guild?.name ?? null,
        available: true,
        botPresent: false,
        botCanManageRoles: false,
        botHighestRolePosition: -1,
      };
    }

    const byId = new Map(roles.map((role) => [role.id, role]));
    const memberRoleIds = member.roles ?? [];
    const botHighestRolePosition = memberRoleIds.reduce(
      (highest, roleId) => Math.max(highest, byId.get(roleId)?.position ?? 0),
      0,
    );

    // Manage Roles: the guild owner always can; otherwise OR the permission bits of
    // @everyone (the role whose id is the guild id) and every role the bot holds, and look
    // for Administrator or Manage Roles.
    const isOwner = guild?.owner_id && guild.owner_id === this.#applicationId;
    let permissions = BigInt(byId.get(discordGuildId)?.permissions ?? '0');
    for (const roleId of memberRoleIds) {
      permissions |= BigInt(byId.get(roleId)?.permissions ?? '0');
    }
    const botCanManageRoles =
      Boolean(isOwner) ||
      (permissions & ADMINISTRATOR) === ADMINISTRATOR ||
      (permissions & MANAGE_ROLES) === MANAGE_ROLES;

    return {
      id: discordGuildId,
      name: guild?.name ?? null,
      available: true,
      botPresent: true,
      botCanManageRoles,
      botHighestRolePosition,
    };
  }

  /** @param {string} discordGuildId @param {string} discordRoleId */
  async getRole(discordGuildId, discordRoleId) {
    const { roles } = await this.#snapshot(discordGuildId);
    const role = roles.find((r) => r.id === discordRoleId);
    if (!role) return null;
    return {
      id: role.id,
      name: role.name,
      position: role.position,
      color: role.color ? role.color : null,
      managed: Boolean(role.managed),
      isEveryone: role.id === discordGuildId,
    };
  }

  /** @param {string} discordGuildId */
  async listRoles(discordGuildId) {
    const { roles } = await this.#snapshot(discordGuildId);
    return roles
      .filter((role) => role.id !== discordGuildId)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
        color: role.color ? role.color : null,
        managed: Boolean(role.managed),
        isEveryone: false,
      }));
  }
}

/**
 * The process-wide REST gateway, built from the environment on first use. Shares the bot
 * token and application id the role catalogue already reads.
 *
 * @param {object} [params]
 * @param {object} [params.env] parsed environment with `DISCORD_BOT_TOKEN` / `DISCORD_CLIENT_ID`
 * @returns {RestRoleGateway}
 */
let shared = null;
export function getRestGateway({ env } = {}) {
  if (!shared) {
    shared = new RestRoleGateway({
      token: env?.DISCORD_BOT_TOKEN,
      applicationId: env?.DISCORD_CLIENT_ID,
    });
  }
  return shared;
}

/** Test seam: drops the shared instance so the next call rebuilds it. */
export function resetRestGateway() {
  shared = null;
}
