/**
 * Shared pieces of the `/esdirector` to-do workflow — the ES Director's twin of `/mike`.
 *
 * A to-do is posted as an embed with ✅ and ❌ reactions. When the ES Director reacts, the
 * item is resolved: ✅ DMs the submitter that it was completed, ❌ that it was denied, and
 * either way the post is deleted so the channel only ever holds open items.
 *
 * The message itself is the store — no database. A to-do is recognised by its embed
 * fingerprint (title + footer), the item text is the embed description, and the person to
 * DM is read back out of the "Requested by" field. That keeps the feature restart-safe.
 *
 * Unlike `/mike`, which is resolved by one fixed person, this list is resolved by whoever
 * holds the ES Director seat — checked by role, so it keeps working when the seat changes
 * hands without a code change.
 */
import { serializeError } from '@frm/logging';
import { memberRoleIds } from './mikeTodo.js';

export const DONE_EMOJI = '✅';
export const DENY_EMOJI = '❌';

/** The embed fingerprint that marks a message as an `/esdirector` to-do. Distinct from `/mike`'s. */
export const ES_TODO_TITLE = '📝 ES To-Do';
export const ES_TODO_FOOTER = 'ES Director To-Do';

/** The embed field that carries the submitter's mention, so they can be DMed the outcome. */
export const REQUESTED_FIELD = 'Requested by';

/** The seat the list belongs to. */
export const ES_DIRECTOR_ROLE_ID = '1535994241392582706';
export const ASST_ES_DIRECTOR_ROLE_ID = '1542221112442618027';

/** Roles pinged above every post — the ES Director and their assistant. */
export const ES_PING_ROLE_IDS = [ES_DIRECTOR_ROLE_ID, ASST_ES_DIRECTOR_ROLE_ID];

/**
 * Who may add an item: FLRP Department Heads, the ES Director seat and Ownership.
 * Override at runtime with ESDIRECTOR_ALLOWED_ROLE_IDS (comma-separated role ids).
 */
export const DEFAULT_ES_ALLOWED_ROLE_IDS = [
  '1534380747689824276', // Owner
  '1534911243142303744', // Co-Owner
  ES_DIRECTOR_ROLE_ID, // ES Director
  ASST_ES_DIRECTOR_ROLE_ID, // Asst. ES Director
  '1534380750173110282', // Department Head
];

/**
 * Who may resolve an item by reacting: the ES Director seat (and their assistant), plus
 * Ownership so the list can always be cleared from the top.
 */
export const ES_RESOLVER_ROLE_IDS = [
  ES_DIRECTOR_ROLE_ID,
  ASST_ES_DIRECTOR_ROLE_ID, // Asst. ES Director
  '1534380747689824276', // Owner
  '1534911243142303744', // Co-Owner
];

/** Whether the caller holds one of the roles allowed to submit. */
export function mayUseEsDirector(interaction, allowedRoleIds) {
  const allowed = allowedRoleIds?.length ? allowedRoleIds : DEFAULT_ES_ALLOWED_ROLE_IDS;
  const held = new Set(memberRoleIds(interaction));
  return allowed.some((id) => held.has(id));
}

/**
 * Resolves a to-do when the ES Director reacts to it.
 *
 * Filters cheaply first — only ✅/❌ get past the guard, then the message is fetched and
 * fingerprinted, and only for a genuine ES to-do is the reacting member looked up to
 * confirm they hold a resolver role. So a stray reaction elsewhere never costs a fetch.
 *
 * @param {import('discord.js').MessageReaction | import('discord.js').PartialMessageReaction} reaction
 * @param {import('discord.js').User | import('discord.js').PartialUser} user
 * @param {{log?: object}} [deps]
 */
export async function handleEsDirectorReaction(reaction, user, { log } = {}) {
  if (!user || user.bot) return;
  const emoji = reaction?.emoji?.name;
  if (emoji !== DONE_EMOJI && emoji !== DENY_EMOJI) return;

  try {
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    const embed = message.embeds?.[0];
    if (!embed || embed.title !== ES_TODO_TITLE || embed.footer?.text !== ES_TODO_FOOTER) return;

    // Only the ES Director seat (or Ownership) resolves items. Anyone else's reaction on
    // the post is ignored rather than treated as a decision.
    const member = await message.guild?.members.fetch(user.id).catch(() => null);
    const held = new Set(member?.roles?.cache ? [...member.roles.cache.keys()] : []);
    if (!ES_RESOLVER_ROLE_IDS.some((id) => held.has(id))) return;

    const content = (embed.description ?? '').trim() || 'your item';

    // Tell whoever submitted the item — read their id back out of the "Requested by" field.
    const requestedField = embed.fields?.find((f) => f.name === REQUESTED_FIELD);
    const requesterId = requestedField?.value?.match(/<@!?(\d+)>/)?.[1] ?? null;
    if (requesterId) {
      const target = await message.client.users.fetch(requesterId).catch(() => null);
      const dm =
        emoji === DONE_EMOJI
          ? `✅ Your ES Director to-do item was completed: ${content}`
          : `❌ Your ES Director to-do item ${content} has been denied. Reach out to the ES Director for more details.`;
      await target?.send(dm).catch(() => {});
    } else {
      log?.warn?.({ messageId: message.id }, 'es director to-do had no requester to DM');
    }

    // A resolved item leaves the channel, checked or denied.
    await message.delete().catch(() => {});
  } catch (error) {
    log?.warn?.({ err: serializeError(error) }, 'es director reaction handling failed');
  }
}
