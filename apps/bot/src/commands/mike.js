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
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { COLORS, errorEmbed, successEmbed, truncate } from '../lib/ui.js';

const log = createLogger('bot.mike');

// Authorized by the command itself (only Mike), not by the bot's actor model, so it runs without
// a linked/tiered bot account. The guild allowlist and rate limit in the guard still apply.
export const actorExempt = true;

/** The one person allowed to add to this to-do list, and who gets pinged. */
const MIKE_DISCORD_ID = '173538213728747520';

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

  try {
    const response = await fetch(env.MIKE_TODO_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // The ping sits above the embed and must actually notify, so allow just this one mention.
        content: `<@${MIKE_DISCORD_ID}>`,
        allowed_mentions: { users: [MIKE_DISCORD_ID] },
        embeds: [
          {
            title: '📝 To-Do',
            description: truncate(item, 4096),
            color: priority.color,
            fields: [{ name: 'Priority', value: `${priority.emoji} ${priority.label}`, inline: true }],
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
  } catch (error) {
    log.warn({ err: serializeError(error) }, 'mike to-do webhook post failed');
    return interaction.editReply({
      embeds: [errorEmbed('Could not add it', 'The to-do channel did not answer. Try again in a moment.')],
    });
  }

  return interaction.editReply({
    embeds: [
      successEmbed('Added to your to-do list', truncate(item, 1024), [
        { name: 'Priority', value: `${priority.emoji} ${priority.label}`, inline: true },
      ]),
    ],
  });
}
