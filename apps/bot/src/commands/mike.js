/**
 * `/mike` — add an item to Mike's personal to-do list.
 *
 * A private utility, not part of the role-management platform: it takes a to-do description and
 * a priority, then posts an embed to a dedicated to-do channel via a webhook, pinging Mike above
 * it so it reaches him. It authorizes its caller itself (only Mike may add to his own list), so it
 * runs without a linked bot actor — the guild allowlist and rate limit still apply.
 *
 * The webhook URL is a secret (its token grants posting to the channel), so it is read from
 * `MIKE_TODO_WEBHOOK_URL` rather than hardcoded. The command reports it is unavailable until set.
 *
 * Each post gets ✅ and ❌ reactions. Mike reacting resolves the item (DM + delete) — that lives
 * in lib/mikeTodo.js, wired to messageReactionAdd in events.js.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { COLORS, errorEmbed, successEmbed, truncate } from '../lib/ui.js';
import { DENY_EMOJI, DONE_EMOJI, MIKE_DISCORD_ID, TODO_FOOTER, TODO_TITLE } from '../lib/mikeTodo.js';

const log = createLogger('bot.mike');

// Authorized by the command itself (only Mike), not by the bot's actor model, so it runs without
// a linked/tiered bot account. The guild allowlist and rate limit in the guard still apply.
export const actorExempt = true;

/** Priority levels, in menu order, each with how it renders in the embed. */
const PRIORITIES = {
  low: { label: 'Low', emoji: '🟢', color: COLORS.success },
  med: { label: 'Medium', emoji: '🟡', color: COLORS.warning },
  high: { label: 'High', emoji: '🔴', color: COLORS.danger },
};

export const data = new SlashCommandBuilder()
  .setName('mike')
  .setDescription("Add an item to Mike's to-do list")
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('item')
      .setDescription('What needs doing')
      .setRequired(true)
      .setMaxLength(2000),
  )
  .addStringOption((option) =>
    option
      .setName('priority')
      .setDescription('How urgent it is')
      .setRequired(true)
      .addChoices(
        { name: 'Low', value: 'low' },
        { name: 'Medium', value: 'med' },
        { name: 'High', value: 'high' },
      ),
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // A personal list: only its owner may add to it, so nobody else can ping him or fill his channel.
  if (interaction.user.id !== MIKE_DISCORD_ID) {
    return interaction.editReply({
      embeds: [errorEmbed('Not for you', "This is Mike's personal to-do list — only he can add to it.")],
    });
  }

  const env = getEnv();
  if (!env.MIKE_TODO_WEBHOOK_URL) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'To-do list unavailable',
          'The to-do channel is not configured yet. Set `MIKE_TODO_WEBHOOK_URL` to the channel webhook.',
        ),
      ],
    });
  }

  const item = interaction.options.getString('item');
  const priority = PRIORITIES[interaction.options.getString('priority')] ?? PRIORITIES.med;

  // wait=true makes the webhook return the created message, so the bot can add the
  // ✅/❌ reactions to it. The footer is the fingerprint the reaction handler matches on.
  const postUrl = `${env.MIKE_TODO_WEBHOOK_URL}${env.MIKE_TODO_WEBHOOK_URL.includes('?') ? '&' : '?'}wait=true`;

  let posted = null;
  try {
    const response = await fetch(postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // The ping sits above the embed and must actually notify, so allow just this one mention.
        content: `<@${MIKE_DISCORD_ID}>`,
        allowed_mentions: { users: [MIKE_DISCORD_ID] },
        embeds: [
          {
            title: TODO_TITLE,
            description: truncate(item, 4096),
            color: priority.color,
            fields: [{ name: 'Priority', value: `${priority.emoji} ${priority.label}`, inline: true }],
            footer: { text: TODO_FOOTER },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log.warn({ status: response.status }, 'mike to-do webhook rejected');
      return interaction.editReply({
        embeds: [
          errorEmbed('Could not add it', `The to-do channel did not accept it (status ${response.status}).`),
        ],
      });
    }
    posted = await response.json().catch(() => null);
  } catch (error) {
    log.warn({ err: serializeError(error) }, 'mike to-do webhook post failed');
    return interaction.editReply({
      embeds: [errorEmbed('Could not add it', 'The to-do channel did not answer. Try again in a moment.')],
    });
  }

  // Add the reactions Mike resolves the item with. Best effort — if the bot cannot react
  // (missing permission in that channel), the item is still posted; it just can't be
  // checked off from Discord until that is fixed.
  let reactable = true;
  if (posted?.id && posted?.channel_id) {
    try {
      const channel = await interaction.client.channels.fetch(posted.channel_id);
      const message = await channel.messages.fetch(posted.id);
      await message.react(DONE_EMOJI);
      await message.react(DENY_EMOJI);
    } catch (error) {
      reactable = false;
      log.warn({ err: serializeError(error) }, 'could not add mike to-do reactions');
    }
  } else {
    reactable = false;
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Added to your to-do list',
        truncate(item, 1024),
        [
          { name: 'Priority', value: `${priority.emoji} ${priority.label}`, inline: true },
          {
            name: 'Resolve it',
            value: reactable
              ? `React ${DONE_EMOJI} to complete or ${DENY_EMOJI} to deny — you'll get a DM either way.`
              : "Posted, but I couldn't add the ✅/❌ reactions (check my channel permissions).",
            inline: false,
          },
        ],
      ),
    ],
  });
}
