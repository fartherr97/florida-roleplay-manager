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
    /** @type {Map<string, Map<string, {id: string, name: string, type: string, parentId: string|null}>>} */
    this.channels = new Map();
    /** Every write the gateway was asked to perform, in order. */
    this.calls = [];
    /** Queue of errors to throw on the next write, keyed by `${guild}:${user}:${role}`. */
    this.failures = new Map();
    this.leftGuilds = [];
    /** Monotonic counter so created roles and channels get stable, unique ids. */
    this.idSeq = 0;
  }

  /** A fresh, snowflake-shaped id (Discord returns numeric ids, so tests must too). */
  #nextId() {
    this.idSeq += 1;
    return String(960000000000000000n + BigInt(this.idSeq));
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
    botCanManageChannels = true,
    botCanManageNicknames = true,
    botHighestRolePosition = 100,
    ownerId = null,
  }) {
    this.guilds.set(id, {
      id,
      name,
      available,
      botPresent,
      botCanManageRoles,
      botCanManageChannels,
      botCanManageNicknames,
      botHighestRolePosition,
      ownerId,
    });
    if (!this.roles.has(id)) this.roles.set(id, new Map());
    if (!this.members.has(id)) this.members.set(id, new Map());
    if (!this.channels.has(id)) this.channels.set(id, new Map());
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

  defineMember(guildId, { id, displayName = `Member ${id}`, nickname = null, roleIds = [] }) {
    if (!this.members.has(guildId)) this.members.set(guildId, new Map());
    // `displayName` is what Discord shows: the nickname when there is one, otherwise the
    // username. Modelled separately because clearing a nickname must fall back, not blank.
    this.members
      .get(guildId)
      .set(id, { id, username: displayName, nickname, roleIds: new Set(roleIds) });
    return this;
  }

  /** The nickname a member currently has, or null when they are using their username. */
  nicknameOf(guildId, memberId) {
    return this.members.get(guildId)?.get(memberId)?.nickname ?? null;
  }

  kickMember(guildId, memberId) {
    this.members.get(guildId)?.delete(memberId);
    return this;
  }

  deleteRole(guildId, roleId) {
    this.roles.get(guildId)?.delete(roleId);
    return this;
  }

  /** Removes a channel, e.g. to simulate one that a first provisioning run never created. */
  deleteChannel(guildId, channelId) {
    this.channels.get(guildId)?.delete(channelId);
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
    return this.#snapshot(discordGuildId, member);
  }

  async listGuilds() {
    return [...this.guilds.values()].map((guild) => ({ id: guild.id, name: guild.name }));
  }

  async listMembers(discordGuildId) {
    return [...(this.members.get(discordGuildId)?.values() ?? [])].map((member) =>
      this.#snapshot(discordGuildId, member),
    );
  }

  /**
   * The gateway's member shape. `highestRolePosition` is what the nickname pre-flight
   * compares against the bot, so it is computed from the roles the member actually holds.
   */
  #snapshot(guildId, member) {
    const roles = this.roles.get(guildId);
    let highest = 0;
    for (const roleId of member.roleIds) {
      const role = roles?.get(roleId);
      if (role && !role.isEveryone && role.position > highest) highest = role.position;
    }
    return {
      id: member.id,
      displayName: member.nickname ?? member.username,
      nickname: member.nickname ?? null,
      username: member.username,
      roleIds: [...member.roleIds],
      highestRolePosition: highest,
      isOwner: this.guilds.get(guildId)?.ownerId === member.id,
    };
  }

  /** A pre-existing channel, for testing idempotent provisioning. */
  defineChannel(guildId, { id, name, type, parentId = null }) {
    if (!this.channels.has(guildId)) this.channels.set(guildId, new Map());
    const channelId = id ?? this.#nextId();
    this.channels.get(guildId).set(channelId, { id: channelId, name, type, parentId });
    return channelId;
  }

  async listChannels(discordGuildId) {
    return [...(this.channels.get(discordGuildId)?.values() ?? [])].map((channel) => ({
      ...channel,
    }));
  }

  async createRole(discordGuildId, spec) {
    this.calls.push({ action: 'CREATE_ROLE', discordGuildId, name: spec.name });
    const id = this.#nextId();
    this.defineRole(discordGuildId, { id, name: spec.name });
    return { id, name: spec.name };
  }

  async editRolePermissions(discordGuildId, discordRoleId, spec = {}) {
    const permissions = spec.permissions ?? [];
    this.calls.push({
      action: 'EDIT_ROLE_PERMISSIONS',
      discordGuildId,
      roleId: discordRoleId,
      permissions,
    });
    const role = this.roles.get(discordGuildId)?.get(discordRoleId);
    if (role) role.permissions = permissions;
    return { id: discordRoleId, name: role?.name ?? discordRoleId };
  }

  async createChannel(discordGuildId, spec) {
    this.calls.push({
      action: 'CREATE_CHANNEL',
      discordGuildId,
      name: spec.name,
      type: spec.type,
      parentId: spec.parentId ?? null,
      overwrites: spec.permissionOverwrites ?? [],
    });
    const id = this.#nextId();
    const channel = { id, name: spec.name, type: spec.type, parentId: spec.parentId ?? null };
    if (!this.channels.has(discordGuildId)) this.channels.set(discordGuildId, new Map());
    this.channels.get(discordGuildId).set(id, channel);
    return { ...channel };
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

  async setNickname(discordGuildId, discordUserId, nickname, reason) {
    this.calls.push({ action: 'SET_NICKNAME', discordGuildId, discordUserId, nickname, reason });
    // Keyed on the member rather than a role, so `failNext(guild, user, null, code)`
    // simulates a rejected rename.
    this.#maybeFail(discordGuildId, discordUserId, null);
    const member = this.#requireMember(discordGuildId, discordUserId);
    member.nickname = nickname ?? null;
    return { applied: true, nickname: member.nickname };
  }

  async banMember(discordGuildId, discordUserId, options = {}) {
    this.calls.push({ action: 'BAN', discordGuildId, discordUserId, ...options });
    this.#maybeFail(discordGuildId, discordUserId, null);
    (this.bans ??= new Set()).add(`${discordGuildId}:${discordUserId}`);
    return { applied: true };
  }

  async unbanMember(discordGuildId, discordUserId, reason) {
    this.calls.push({ action: 'UNBAN', discordGuildId, discordUserId, reason });
    this.#maybeFail(discordGuildId, discordUserId, null);
    const key = `${discordGuildId}:${discordUserId}`;
    if (!this.bans?.has(key)) return { applied: false, reason: 'not_banned' };
    this.bans.delete(key);
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
