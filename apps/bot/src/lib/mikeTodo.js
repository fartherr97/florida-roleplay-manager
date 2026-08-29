/**
 * Shared pieces of the `/mike` to-do workflow.
 *
 * A to-do is posted as an embed with ✅ and ❌ reactions. When Mike reacts, the item is
 * resolved: ✅ DMs him that it was completed, ❌ DMs him that it was denied, and either
 * way the post is deleted so the channel only ever holds open items.
 *
 * The message itself is the store — no database. A to-do is recognised by its embed
 * fingerprint (title + footer), the item text is the embed description, and the person to
 * DM is the command's runner, which is always Mike because `/mike` is gated to him. That
 * keeps the whole feature restart-safe: a posted item still resolves after a redeploy.
 */
import { serializeError } from '@frm/logging';

/** The one person who may run `/mike` and resolve its items; also who gets the DM. */
export const MIKE_DISCORD_ID = '173538213728747520';

export const DONE_EMOJI = '✅';
export const DENY_EMOJI = '❌';

/** The embed fingerprint that marks a message as a `/mike` to-do. */
export const TODO_TITLE = '📝 To-Do';
export const TODO_FOOTER = 'Mike To-Do';

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

    // The runner is always Mike (the command is gated to him), so that is who is told.
    const target = await message.client.users.fetch(MIKE_DISCORD_ID);
    const dm =
      emoji === DONE_EMOJI
        ? `✅ Your Mike to-do item was completed: ${content}`
        : `❌ Your Mike to-do item ${content} has been denied. Reach out to Mike for more details.`;
    await target.send(dm).catch(() => {});

    // A resolved item leaves the channel, checked or denied.
    await message.delete().catch(() => {});
  } catch (error) {
    log?.warn?.({ err: serializeError(error) }, 'mike reaction handling failed');
  }
}
