/**
 * In-memory gateway.
 *
 * The whole synchronization test suite runs against this, so it models the parts of
 * Discord that actually cause production failures: role hierarchy, integration-managed
 * roles, missing members, missing permissions, deleted roles, and rate limits.
 */
import { mapDiscordError } from './errors.js';

export class MockRoleGateway {
  constructor() {
    this.name = 'mock';
    /** @type {Map<string, {id: string, name: string, available: boolean, botPresent: boolean, botCanManageRoles: boolean, botHighestRolePosition: number}>} */
    this.guilds = new Map();
    /** @type {Map<string, Map<string, {id: string, name: string, position: number, managed: boolean, isEveryone: boolean}>>} */
    this.roles = new Map();
    /** @type {Map<string, Map<string, {id: string, displayName: string, roleIds: Set<string>}>>} */
    this.members = new Map();
    /** Every write the gateway was asked to perform, in order. */
    this.calls = [];
    /** Queue of errors to throw on the next write, keyed by `${guild}:${user}:${role}`. */
    this.failures = new Map();
    this.leftGuilds = [];
  }

  // --- test fixtures -------------------------------------------------------
  // Named `defineX` rather than `addX` so they can never collide with the gateway's
  // own `addRole`/`removeRole` methods.

  defineGuild({
    id,
    name = `Guild ${id}`,
    available = true,
    botPresent = true,
    botCanManageRoles = true,
    botHighestRolePosition = 100,
  }) {
    this.guilds.set(id, {
      id,
      name,
      available,
      botPresent,
      botCanManageRoles,
      botHighestRolePosition,
    });
    if (!this.roles.has(id)) this.roles.set(id, new Map());
    if (!this.members.has(id)) this.members.set(id, new Map());
    // Every guild has an @everyone role whose id equals the guild id.
    this.roles
      .get(id)
      .set(id, { id, name: '@everyone', position: 0, managed: false, isEveryone: true });
    return this;
  }

  defineRole(guildId, { id, name = `Role ${id}`, position = 10, managed = false }) {
    if (!this.roles.has(guildId)) this.roles.set(guildId, new Map());
    this.roles.get(guildId).set(id, { id, name, position, managed, isEveryone: false });
    return this;
  }

  defineMember(guildId, { id, displayName = `Member ${id}`, roleIds = [] }) {
    if (!this.members.has(guildId)) this.members.set(guildId, new Map());
    this.members.get(guildId).set(id, { id, displayName, roleIds: new Set(roleIds) });
    return this;
  }

  kickMember(guildId, memberId) {
    this.members.get(guildId)?.delete(memberId);
    return this;
  }

  deleteRole(guildId, roleId) {
    this.roles.get(guildId)?.delete(roleId);
    return this;
  }

  /** Makes the next write for this triple fail with the given Discord error code. */
  failNext(guildId, userId, roleId, code) {
    const key = `${guildId}:${userId}:${roleId}`;
    const queue = this.failures.get(key) ?? [];
    queue.push(code);
    this.failures.set(key, queue);
    return this;
  }

  /** The role ids a member currently holds, as a sorted array. */
  rolesOf(guildId, memberId) {
    return [...(this.members.get(guildId)?.get(memberId)?.roleIds ?? [])].sort();
  }

  reset() {
    this.calls = [];
    this.failures.clear();
    this.leftGuilds = [];
  }

  // --- gateway interface ---------------------------------------------------

  async getGuild(discordGuildId) {
    return this.guilds.get(discordGuildId) ?? null;
  }

  async getRole(discordGuildId, discordRoleId) {
    return this.roles.get(discordGuildId)?.get(discordRoleId) ?? null;
  }

  async listRoles(discordGuildId) {
    return [...(this.roles.get(discordGuildId)?.values() ?? [])];
  }

  async getMember(discordGuildId, discordUserId) {
    const member = this.members.get(discordGuildId)?.get(discordUserId);
    if (!member) return null;
    return {
      id: member.id,
      displayName: member.displayName,
      roleIds: [...member.roleIds],
    };
  }

  async listGuilds() {
    return [...this.guilds.values()].map((guild) => ({ id: guild.id, name: guild.name }));
  }

  async listMembers(discordGuildId) {
    return [...(this.members.get(discordGuildId)?.values() ?? [])].map((member) => ({
      id: member.id,
      displayName: member.displayName,
      roleIds: [...member.roleIds],
    }));
  }

  async addRole(discordGuildId, discordUserId, discordRoleId, reason) {
    this.calls.push({ action: 'ADD_ROLE', discordGuildId, discordUserId, discordRoleId, reason });
    this.#maybeFail(discordGuildId, discordUserId, discordRoleId);
    const member = this.#requireMember(discordGuildId, discordUserId);
    this.#requireRole(discordGuildId, discordRoleId);
    member.roleIds.add(discordRoleId);
    return { applied: true };
  }

  async removeRole(discordGuildId, discordUserId, discordRoleId, reason) {
    this.calls.push({
      action: 'REMOVE_ROLE',
      discordGuildId,
      discordUserId,
      discordRoleId,
      reason,
    });
    this.#maybeFail(discordGuildId, discordUserId, discordRoleId);
    const member = this.#requireMember(discordGuildId, discordUserId);
    this.#requireRole(discordGuildId, discordRoleId);
    member.roleIds.delete(discordRoleId);
    return { applied: true };
  }

  async leaveGuild(discordGuildId) {
    this.leftGuilds.push(discordGuildId);
    this.guilds.delete(discordGuildId);
    return true;
  }

  #maybeFail(guildId, userId, roleId) {
    const key = `${guildId}:${userId}:${roleId}`;
    const queue = this.failures.get(key);
    if (queue?.length) {
      const code = queue.shift();
      const error = new Error(`Simulated Discord failure ${code}`);
      error.code = code;
      error.status = code === 429 ? 429 : 400;
      throw mapDiscordError(error, {
        discordGuildId: guildId,
        discordUserId: userId,
        discordRoleId: roleId,
      });
    }
  }

  #requireMember(guildId, userId) {
    const member = this.members.get(guildId)?.get(userId);
    if (!member) {
      const error = new Error('Unknown member');
      error.code = 10007;
      throw mapDiscordError(error, { discordGuildId: guildId, discordUserId: userId });
    }
    return member;
  }

  #requireRole(guildId, roleId) {
    const role = this.roles.get(guildId)?.get(roleId);
    if (!role) {
      const error = new Error('Unknown role');
      error.code = 10011;
      throw mapDiscordError(error, { discordGuildId: guildId, discordRoleId: roleId });
    }
    return role;
  }
}
