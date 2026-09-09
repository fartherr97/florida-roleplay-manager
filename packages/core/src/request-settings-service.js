/**
 * Per-guild settings for the training / interview request commands.
 *
 * Which channel `/requesttraining` and `/requestinterview` post in for a guild, and which
 * roles they ping inside the thread they open. Written by Ownership through
 * `/requestconfig`; read by the request commands, which fall back to the env maps when a
 * guild has no row. Keyed by raw Discord guild id so it works in any guild the bot is in.
 *
 * Authorization is the caller's job (the command gates on Ownership roles), so these are
 * plain data functions rather than ctx-scoped services.
 */
import { getPrisma } from '@frm/database';

/** @typedef {'training'|'interview'} RequestKindKey */

const KIND_TO_ENUM = { training: 'TRAINING', interview: 'INTERVIEW' };
const ENUM_TO_KIND = { TRAINING: 'training', INTERVIEW: 'interview' };

function toEnum(kind) {
  const value = KIND_TO_ENUM[kind];
  if (!value) throw new Error(`unknown request kind: ${kind}`);
  return value;
}

function shape(row) {
  if (!row) return null;
  return {
    guildId: row.discordGuildId,
    kind: ENUM_TO_KIND[row.kind],
    channelId: row.channelId,
    pingRoleIds: row.pingRoleIds ?? [],
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt,
  };
}

/**
 * @param {string} discordGuildId
 * @param {RequestKindKey} kind
 * @returns {Promise<{guildId: string, kind: RequestKindKey, channelId: string, pingRoleIds: string[]}|null>}
 */
export async function getRequestSettings(discordGuildId, kind) {
  const row = await getPrisma().guildRequestSettings.findUnique({
    where: { discordGuildId_kind: { discordGuildId, kind: toEnum(kind) } },
  });
  return shape(row);
}

/** Every configured kind for a guild. */
export async function listRequestSettings(discordGuildId) {
  const rows = await getPrisma().guildRequestSettings.findMany({
    where: { discordGuildId },
    orderBy: { kind: 'asc' },
  });
  return rows.map(shape);
}

/**
 * Create or replace a guild's settings for one kind.
 * @param {{discordGuildId: string, kind: RequestKindKey, channelId: string, pingRoleIds: string[], updatedBy?: string|null}} input
 */
export async function setRequestSettings({ discordGuildId, kind, channelId, pingRoleIds, updatedBy = null }) {
  const roles = [...new Set((pingRoleIds ?? []).filter(Boolean))];
  const row = await getPrisma().guildRequestSettings.upsert({
    where: { discordGuildId_kind: { discordGuildId, kind: toEnum(kind) } },
    create: { discordGuildId, kind: toEnum(kind), channelId, pingRoleIds: roles, updatedBy },
    update: { channelId, pingRoleIds: roles, updatedBy },
  });
  return shape(row);
}

/** Remove a guild's settings for one kind. Returns whether anything was removed. */
export async function clearRequestSettings(discordGuildId, kind) {
  const result = await getPrisma().guildRequestSettings.deleteMany({
    where: { discordGuildId, kind: toEnum(kind) },
  });
  return result.count > 0;
}
