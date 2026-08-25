/**
 * Reading a guild's Discord roles without a gateway connection.
 *
 * The API process has no gateway. It never logs in, holds no cache and receives no events,
 * which is deliberate: the bot observes and the worker writes, and giving the API its own
 * connection would mean a third process with an opinion about Discord's state.
 *
 * But the website still has to offer a role picker, and a picker needs the roles. Listing
 * them is a plain REST `GET`, authenticated with the bot token and needing none of that
 * machinery — and it is a read, so it leaves intact the rule that the worker is the only
 * process that writes to Discord.
 *
 * Results are cached briefly. A role list changes rarely, and a dashboard renders a picker
 * on every screen that touches roles, so a short TTL collapses a burst of page loads into
 * one API call without ever serving a list old enough to matter. In-flight requests are
 * shared rather than duplicated, so a cold cache under concurrent load still makes one
 * call rather than one per caller.
 */
import { REST, Routes } from 'discord.js';
import { createLogger, serializeError } from '@frm/logging';
import { mapDiscordError } from './errors.js';

const log = createLogger('discord.role-catalog');

/** Long enough to absorb a page load, short enough that a new role appears promptly. */
export const DEFAULT_ROLE_CACHE_TTL_MS = 60_000;

/**
 * A guild's roles as the dashboard needs them.
 *
 * @typedef {object} CatalogRole
 * @property {string} id the Discord snowflake
 * @property {string} name
 * @property {number} position higher outranks lower; `@everyone` is 0
 * @property {number} color integer RGB, 0 when unset
 * @property {boolean} hoist displayed separately in the member list
 * @property {boolean} mentionable
 * @property {boolean} managed owned by an integration, so nobody can assign it by hand
 * @property {boolean} assignable the bot could actually grant or remove it
 */

export class DiscordRoleCatalog {
  #rest;
  #applicationId;
  #ttlMs;
  /** @type {Map<string, {expiresAt: number, promise: Promise<object>}>} */
  #cache = new Map();

  /**
   * @param {object} params
   * @param {string} [params.token] bot token; ignored when `rest` is supplied
   * @param {string} [params.applicationId] the bot's application id, which for a bot is
   *   also its user id — `/users/@me/guilds/:id/member` needs an OAuth token, so reading
   *   the bot's own membership means asking for it by id like any other member
   * @param {number} [params.ttlMs]
   * @param {object} [params.rest] an injected REST-alike, for tests
   */
  constructor({ token, applicationId, ttlMs = DEFAULT_ROLE_CACHE_TTL_MS, rest } = {}) {
    this.#rest = rest ?? new REST({ version: '10' }).setToken(token);
    this.#applicationId = applicationId;
    this.#ttlMs = ttlMs;
  }

  /**
   * Lists a guild's roles, and works out which of them the bot could actually assign.
   *
   * The `assignable` flag is the useful part. A role above the bot's own highest role
   * cannot be granted or removed by it no matter what permissions it holds — that single
   * fact is behind most reports of "the bot deployed fine and does nothing", and it is far
   * better surfaced greyed-out in a picker than as a sync issue an hour later.
   *
   * @param {string} discordGuildId
   * @param {object} [options]
   * @param {boolean} [options.force] bypass the cache
   * @returns {Promise<{roles: CatalogRole[], botHighestPosition: number, cachedAt: string}>}
   */
  async listRoles(discordGuildId, { force = false } = {}) {
    const cached = this.#cache.get(discordGuildId);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.promise;

    const promise = this.#fetch(discordGuildId).catch((error) => {
      // A failed lookup must not be cached, or one blip poisons the picker for a minute.
      this.#cache.delete(discordGuildId);
      throw error;
    });

    this.#cache.set(discordGuildId, { expiresAt: Date.now() + this.#ttlMs, promise });
    return promise;
  }

  /** Drops a guild's cached roles, so the next read is fresh. */
  invalidate(discordGuildId) {
    this.#cache.delete(discordGuildId);
  }

  async #fetch(discordGuildId) {
    let roles;
    let botRoleIds = [];

    try {
      roles = await this.#rest.get(Routes.guildRoles(discordGuildId));
    } catch (error) {
      log.error({ err: serializeError(error), discordGuildId }, 'could not list roles for guild');
      throw mapDiscordError(error, { discordGuildId });
    }

    // The bot's own position decides what it can assign. Failing to read it is not fatal:
    // better a picker with nothing marked assignable than no picker at all, so this
    // degrades rather than throws.
    if (this.#applicationId) {
      try {
        const me = await this.#rest.get(Routes.guildMember(discordGuildId, this.#applicationId));
        botRoleIds = me?.roles ?? [];
      } catch (error) {
        log.warn(
          { err: serializeError(error), discordGuildId },
          'could not read the bot member; assignability is unknown',
        );
      }
    }

    const byId = new Map(roles.map((role) => [role.id, role]));
    const botHighestPosition = botRoleIds.reduce(
      (highest, roleId) => Math.max(highest, byId.get(roleId)?.position ?? 0),
      0,
    );

    return {
      // Highest first, which is the order a rank list is read in.
      roles: roles
        .filter((role) => role.id !== discordGuildId) // @everyone: never a real choice
        .sort((a, b) => b.position - a.position)
        .map((role) => ({
          id: role.id,
          name: role.name,
          position: role.position,
          color: role.color ?? 0,
          hoist: Boolean(role.hoist),
          mentionable: Boolean(role.mentionable),
          managed: Boolean(role.managed),
          assignable: !role.managed && botHighestPosition > 0 && role.position < botHighestPosition,
        })),
      botHighestPosition,
      cachedAt: new Date().toISOString(),
    };
  }
}

/**
 * The process-wide catalogue, built from the environment on first use.
 *
 * A single instance is what makes the cache worth having: one per request would fetch
 * every time and the TTL would never be reached.
 *
 * @param {object} [params]
 * @param {object} [params.env] parsed environment providing `DISCORD_BOT_TOKEN` and
 *   `DISCORD_CLIENT_ID`
 * @returns {DiscordRoleCatalog}
 */
let shared = null;
export function getRoleCatalog({ env } = {}) {
  if (!shared) {
    shared = new DiscordRoleCatalog({
      token: env?.DISCORD_BOT_TOKEN,
      applicationId: env?.DISCORD_CLIENT_ID,
    });
  }
  return shared;
}

/** Test seam: drops the shared instance so the next call rebuilds it. */
export function resetRoleCatalog() {
  shared = null;
}
