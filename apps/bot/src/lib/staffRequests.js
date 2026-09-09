/**
 * Shared pieces of the staff request commands (`/request ban`, `/request da`).
 *
 * A request is an embed posted into the staff request channel with the Support Team role
 * pinged above it, so it reaches the people who action it. The commands authorize their
 * caller themselves (staff roles), so they run without a linked bot actor — the guild
 * allowlist and rate limit in the guard still apply.
 */
import { createLogger, serializeError } from '@frm/logging';
import { memberRoleIds } from './mikeTodo.js';

const log = createLogger('bot.requests');

/**
 * Staff allowed to file a request. Defaults to the Server Staff Team role; override at
 * runtime with REQUEST_ALLOWED_ROLE_IDS (comma-separated role ids).
 */
export const DEFAULT_REQUEST_ROLE_IDS = [
  '1534380749304889384', // Server Staff Team
];

/** Whether the caller holds one of the roles allowed to file requests. */
export function mayFileRequest(interaction, allowedRoleIds) {
  const allowed = allowedRoleIds?.length ? allowedRoleIds : DEFAULT_REQUEST_ROLE_IDS;
  const held = new Set(memberRoleIds(interaction));
  return allowed.some((id) => held.has(id));
}

/**
 * Posts a request embed to the configured channel, pinging the Support Team role above it.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{channelId: string, pingRoleId?: string, embed: object}} args
 * @returns {Promise<{ok: true, pinged: boolean} | {ok: false, reason: string}>}
 */
export async function postRequest(interaction, { channelId, pingRoleId, embed }) {
  let channel;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch (error) {
    log.warn({ err: serializeError(error), channelId }, 'request channel fetch failed');
    return { ok: false, reason: 'channel_unavailable' };
  }
  if (!channel?.isTextBased?.()) return { ok: false, reason: 'channel_unavailable' };

  const pinged = Boolean(pingRoleId);
  try {
    await channel.send({
      // The ping sits above the embed and must actually notify, so allow just that role.
      content: pinged ? `<@&${pingRoleId}>` : undefined,
      allowedMentions: pinged ? { roles: [pingRoleId] } : { parse: [] },
      embeds: [embed],
    });
  } catch (error) {
    log.warn({ err: serializeError(error), channelId }, 'request post failed');
    return { ok: false, reason: 'send_failed' };
  }
  return { ok: true, pinged };
}

/** Display name for a user in this guild, best-effort; the mention is what matters. */
export async function displayNameOf(interaction, user) {
  return interaction.guild?.members
    .fetch(user.id)
    .then((member) => member.displayName)
    .catch(() => user.globalName ?? user.username);
}
