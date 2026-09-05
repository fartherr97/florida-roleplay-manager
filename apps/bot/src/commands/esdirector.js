/**
 * `/esdirector` — add an item to the ES Director's to-do list.
 *
 * The ES Director's twin of `/mike`. It takes a to-do description and a priority, then posts
 * an embed to a dedicated to-do channel via a webhook, pinging the ES Director role above it
 * so it reaches whoever holds the seat. It authorizes its caller itself (Department Heads,
 * the ES Director seat and Ownership), so it runs without a linked bot actor — the guild
 * allowlist and rate limit still apply.
 *
 * The webhook URL is a secret (its token grants posting to the channel), so it is read from
 * `ESDIRECTOR_TODO_WEBHOOK_URL` rather than hardcoded. The command reports it is unavailable
 * until set.
 *
 * Each post gets ✅ and ❌ reactions. The ES Director reacting resolves the item (DM + delete)
 * — that lives in lib/esDirectorTodo.js, wired to messageReactionAdd in events.js.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { COLORS, errorEmbed, successEmbed, truncate } from '../lib/ui.js';
import {
  DENY_EMOJI,
  DONE_EMOJI,
  ES_DIRECTOR_ROLE_ID,
  ES_TODO_FOOTER,
  ES_TODO_TITLE,
  REQUESTED_FIELD,
  mayUseEsDirector,
} from '../lib/esDirectorTodo.js';

const log = createLogger('bot.esdirector');

// Authorized by the command itself, not by the bot's actor model, so it runs without a
// linked/tiered bot account. The guild allowlist and rate limit in the guard still apply.
export const actorExempt = true;

/** Priority levels, in menu order, each with how it renders in the embed. */
const PRIORITIES = {
  low: { label: 'Low', emoji: '🟢', color: COLORS.success },
  med: { label: 'Medium', emoji: '🟡', color: COLORS.warning },
  high: { label: 'High', emoji: '🔴', color: COLORS.danger },
};

export const data = new SlashCommandBuilder()
  .setName('esdirector')
  .setDescription("Add an item to the ES Director's to-do list")
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

  const env = getEnv();

  // Department Heads, the ES Director seat and Ownership. The allowed roles can be
  // overridden with ESDIRECTOR_ALLOWED_ROLE_IDS. Who submitted it is recorded on the post so
  // that when the item is resolved, the DM goes back to them.
  if (!mayUseEsDirector(interaction, env.ESDIRECTOR_ALLOWED_ROLE_IDS)) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Department Heads and up only',
          "Only Department Heads, the ES Director and Ownership can add to the ES Director's to-do list.",
        ),
      ],
    });
  }
  const requesterId = interaction.user.id;

  if (!env.ESDIRECTOR_TODO_WEBHOOK_URL) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'To-do list unavailable',
          'The to-do channel is not configured yet. Set `ESDIRECTOR_TODO_WEBHOOK_URL` to the channel webhook.',
        ),
      ],
    });
  }

  const item = interaction.options.getString('item');
  const priority = PRIORITIES[interaction.options.getString('priority')] ?? PRIORITIES.med;

  // wait=true makes the webhook return the created message, so the bot can add the
  // ✅/❌ reactions to it. The footer is the fingerprint the reaction handler matches on.
  const base = env.ESDIRECTOR_TODO_WEBHOOK_URL;
  const postUrl = `${base}${base.includes('?') ? '&' : '?'}wait=true`;

  let posted = null;
  try {
    const response = await fetch(postUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // The ping sits above the embed and must actually notify the seat, so allow just
        // this one role mention.
        content: `<@&${ES_DIRECTOR_ROLE_ID}>`,
        allowed_mentions: { roles: [ES_DIRECTOR_ROLE_ID] },
        embeds: [
          {
            title: ES_TODO_TITLE,
            description: truncate(item, 4096),
            color: priority.color,
            fields: [
              { name: 'Priority', value: `${priority.emoji} ${priority.label}`, inline: true },
              // The mention renders as the requester's name and never pings (it is in an
              // embed field). The reaction handler reads the id back out of it to DM them.
              { name: REQUESTED_FIELD, value: `<@${requesterId}>`, inline: true },
            ],
            footer: { text: ES_TODO_FOOTER },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log.warn({ status: response.status }, 'es director to-do webhook rejected');
      return interaction.editReply({
        embeds: [
          errorEmbed('Could not add it', `The to-do channel did not accept it (status ${response.status}).`),
        ],
      });
    }
    posted = await response.json().catch(() => null);
  } catch (error) {
    log.warn({ err: serializeError(error) }, 'es director to-do webhook post failed');
    return interaction.editReply({
      embeds: [errorEmbed('Could not add it', 'The to-do channel did not answer. Try again in a moment.')],
    });
  }

  // Add the reactions the item is resolved with. Best effort — if the bot cannot react
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
      log.warn({ err: serializeError(error) }, 'could not add es director to-do reactions');
    }
  } else {
    reactable = false;
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        "Sent to the ES Director's to-do list",
        truncate(item, 1024),
        [
          { name: 'Priority', value: `${priority.emoji} ${priority.label}`, inline: true },
          {
            name: 'What happens next',
            value: reactable
              ? 'The ES Director will check it off or deny it — either way the bot will DM you the outcome.'
              : "Posted, but I couldn't add the ✅/❌ reactions (an admin should check my channel permissions).",
            inline: false,
          },
        ],
      ),
    ],
  });
}
