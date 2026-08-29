/**
 * Shared pieces of the `/mike` to-do workflow.
 *
 * A to-do is posted as an embed with ✅ and ❌ reactions. When Mike reacts, the item is
 * resolved: ✅ DMs him that it was completed, ❌ DMs him that it was denied, and either
 * way the post is deleted so the channel only ever holds open items.
 *
 * The message itself is the store — no database. A to-do is recognised by its embed
 * fingerprint (title + footer), the item text is the embed description, and the person to
 * DM is read back out of the "Requested by" field, which carries the submitter's mention.
 * That keeps the whole feature restart-safe: a posted item still resolves after a redeploy.
 */
import { serializeError } from '@frm/logging';

/** The one person who resolves items by reacting. Anyone may submit; only Mike checks off. */
export const MIKE_DISCORD_ID = '173538213728747520';

export const DONE_EMOJI = '✅';
export const DENY_EMOJI = '❌';

/** The embed fingerprint that marks a message as a `/mike` to-do. */
export const TODO_TITLE = '📝 To-Do';
export const TODO_FOOTER = 'Mike To-Do';

/** The embed field that carries the submitter's mention, so they can be DMed the outcome. */
export const REQUESTED_FIELD = 'Requested by';

/**
 * Community Director and up — the roles allowed to submit a `/mike` to-do.
 *
 * Ownership and the four director seats (Staff, ES, Dev, Civilian); assistant directors
 * are below "Director" and are not included. Override at runtime with the
 * MIKE_ALLOWED_ROLE_IDS env var (comma-separated role ids) without touching this list.
 */
export const DEFAULT_DIRECTOR_ROLE_IDS = [
  '1534380747689824276', // Owner
  '1534911243142303744', // Co-Owner
  '1535994200808497162', // Staff Director
  '1535994241392582706', // ES Director
  '1535994278193528912', // Dev Director
  '1535994315258724415', // Civilian Director
];

/** The caller's role ids, tolerating both the GuildMember and raw-interaction shapes. */
export function memberRoleIds(interaction) {
  const roles = interaction?.member?.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles; // raw APIInteractionGuildMember.roles
  if (roles.cache) return [...roles.cache.keys()]; // GuildMemberRoleManager
  return [];
}

/** Whether the caller holds one of the allowed (Director+) roles. */
export function mayUseMike(interaction, allowedRoleIds) {
  const allowed = allowedRoleIds?.length ? allowedRoleIds : DEFAULT_DIRECTOR_ROLE_IDS;
  const held = new Set(memberRoleIds(interaction));
  return allowed.some((id) => held.has(id));
}

/**
 * Resolves a to-do when Mike reacts to it.
 *
 * Filters cheaply first — only Mike's ✅/❌ reactions get past the guards, so a stray
 * reaction anywhere never costs a message fetch. Only then is the (possibly uncached,
 * webhook-posted) message fetched and fingerprinted before anything is DMed or deleted.
 *
 * @param {import('discord.js').MessageReaction | import('discord.js').PartialMessageReaction} reaction
 * @param {import('discord.js').User | import('discord.js').PartialUser} user
 * @param {{log?: object}} [deps]
 */
export async function handleMikeReaction(reaction, user, { log } = {}) {
  if (user?.id !== MIKE_DISCORD_ID) return;
  const emoji = reaction?.emoji?.name;
  if (emoji !== DONE_EMOJI && emoji !== DENY_EMOJI) return;

  try {
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    const embed = message.embeds?.[0];
    if (!embed || embed.title !== TODO_TITLE || embed.footer?.text !== TODO_FOOTER) return;

    const content = (embed.description ?? '').trim() || 'your item';

    // Tell whoever submitted the item — read their id back out of the "Requested by" field.
    const requestedField = embed.fields?.find((f) => f.name === REQUESTED_FIELD);
    const requesterId = requestedField?.value?.match(/<@!?(\d+)>/)?.[1] ?? null;
    if (requesterId) {
      const target = await message.client.users.fetch(requesterId).catch(() => null);
      const dm =
        emoji === DONE_EMOJI
          ? `✅ Your Mike to-do item was completed: ${content}`
          : `❌ Your Mike to-do item ${content} has been denied. Reach out to Mike for more details.`;
      await target?.send(dm).catch(() => {});
    } else {
      log?.warn?.({ messageId: message.id }, 'mike to-do had no requester to DM');
    }

    // A resolved item leaves the channel, checked or denied.
    await message.delete().catch(() => {});
  } catch (error) {
    log?.warn?.({ err: serializeError(error) }, 'mike reaction handling failed');
  }
}
