/**
 * Interaction presentation helpers.
 *
 * Everything a command needs to talk to a human: embeds, confirmations, pagination and
 * consistent error rendering. Keeping it here means the commands themselves stay a thin
 * translation between Discord input and a `@frm/core` call.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { CONFIRMATION_TTL_MS, DISCORD_LIMITS, isAppError } from '@frm/shared';

export const COLORS = Object.freeze({
  success: 0x2ecc71,
  danger: 0xe74c3c,
  warning: 0xe67e22,
  info: 0x3498db,
  neutral: 0x95a5a6,
});

/** Truncates a string to a Discord field limit, with an ellipsis. */
export function truncate(text, limit = DISCORD_LIMITS.EMBED_FIELD_VALUE) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

/** Renders `null`/`undefined` as an em dash so embeds never show "undefined". */
export function orDash(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {Array<{name: string, value: string, inline?: boolean}>} [options.fields]
 * @param {keyof COLORS} [options.color]
 * @param {string} [options.footer]
 */
export function buildEmbed({ title, description, fields = [], color = 'info', footer }) {
  const embed = new EmbedBuilder()
    .setTitle(truncate(title, 256))
    .setColor(COLORS[color] ?? COLORS.info);

  if (description) embed.setDescription(truncate(description, DISCORD_LIMITS.EMBED_DESCRIPTION));
  if (footer) embed.setFooter({ text: truncate(footer, 2048) });

  for (const field of fields.slice(0, DISCORD_LIMITS.EMBED_FIELDS)) {
    embed.addFields({
      name: truncate(field.name, 256),
      value: truncate(field.value ?? '—'),
      inline: Boolean(field.inline),
    });
  }

  return embed;
}

/** Replies (or edits, if already deferred) with an ephemeral embed. */
export async function respond(interaction, embed, components = []) {
  const payload = {
    embeds: [embed],
    components,
    flags: MessageFlags.Ephemeral,
  };

  if (interaction.deferred || interaction.replied) {
    // `flags` cannot be changed after the initial response.
    return interaction.editReply({ embeds: [embed], components });
  }
  return interaction.reply(payload);
}

export function successEmbed(title, description, fields) {
  return buildEmbed({ title, description, fields, color: 'success' });
}

export function errorEmbed(title, description, fields) {
  return buildEmbed({ title, description, fields, color: 'danger' });
}

/**
 * Renders an error for a member.
 *
 * Application errors carry a message written for the person reading it. Anything else
 * is deliberately opaque: an unexpected failure gets a correlation id, and the details
 * go to the logs where they belong rather than into a Discord channel.
 */
export function renderError(error, requestId) {
  if (isAppError(error)) {
    const fields = [];
    if (error.details?.chain) {
      fields.push({ name: 'Conflicting chain', value: truncate(error.details.chain.join('\n→ ')) });
    }
    if (error.details?.issues) {
      fields.push({
        name: 'Invalid input',
        value: truncate(
          error.details.issues.map((issue) => `• ${issue.field}: ${issue.message}`).join('\n'),
        ),
      });
    }
    return errorEmbed(errorTitle(error), error.userMessage, fields);
  }

  return errorEmbed(
    'Something went wrong',
    'That command failed unexpectedly. An administrator can find the details in the logs.',
    requestId ? [{ name: 'Reference', value: `\`${requestId}\`` }] : [],
  );
}

function errorTitle(error) {
  switch (error.code) {
    case 'FORBIDDEN':
    case 'SELF_MANAGEMENT':
    case 'RANK_CEILING':
      return 'Not allowed';
    case 'GUILD_NOT_APPROVED':
      return 'Server not approved';
    case 'VALIDATION_FAILED':
      return 'Check the input';
    case 'MAPPING_CYCLE':
      return 'That would create a loop';
    case 'PROTECTED_ROLE':
      return 'Protected role';
    case 'ROLE_HIERARCHY':
      return 'Role hierarchy problem';
    case 'CONFLICT':
      return 'Conflict';
    case 'NOT_FOUND':
      return 'Not found';
    case 'THRESHOLD_EXCEEDED':
      return 'Too many changes';
    default:
      return 'Unable to continue';
  }
}

/**
 * Asks the member to confirm before something destructive or large happens.
 *
 * The buttons are bound to a one-off id and to the member who ran the command, so
 * another user cannot click somebody else's confirmation. Timing out is treated as "no".
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} options
 * @returns {Promise<boolean>}
 */
export async function requestConfirmation(interaction, options) {
  const {
    title,
    description,
    fields = [],
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = true,
  } = options;

  const token = randomUUID();
  const embed = buildEmbed({
    title,
    description,
    fields,
    color: danger ? 'danger' : 'warning',
    footer: 'This confirmation expires in 2 minutes.',
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${token}`)
      .setLabel(confirmLabel)
      .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`cancel:${token}`)
      .setLabel(cancelLabel)
      .setStyle(ButtonStyle.Secondary),
  );

  const message = await respond(interaction, embed, [row]);

  try {
    const response = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: CONFIRMATION_TTL_MS,
      filter: (component) =>
        component.user.id === interaction.user.id && component.customId.endsWith(token),
    });

    const confirmed = response.customId.startsWith('confirm:');
    await response.update({
      embeds: [
        buildEmbed({
          title: confirmed ? 'Confirmed' : 'Cancelled',
          description: confirmed ? 'Working on it...' : 'Nothing was changed.',
          color: confirmed ? 'info' : 'neutral',
        }),
      ],
      components: [],
    });
    return confirmed;
  } catch {
    await interaction
      .editReply({
        embeds: [
          buildEmbed({
            title: 'Confirmation timed out',
            description: 'Nothing was changed. Run the command again if you still want to proceed.',
            color: 'neutral',
          }),
        ],
        components: [],
      })
      .catch(() => {});
    return false;
  }
}

/**
 * Paginates a list of embeds with previous/next buttons.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {EmbedBuilder[]} pages
 */
export async function paginate(interaction, pages) {
  if (pages.length === 0) {
    return respond(interaction, buildEmbed({ title: 'Nothing to show', color: 'neutral' }));
  }
  if (pages.length === 1) {
    return respond(interaction, pages[0]);
  }

  const token = randomUUID();
  let index = 0;

  const buildRow = () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`prev:${token}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === 0),
      new ButtonBuilder()
        .setCustomId(`next:${token}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === pages.length - 1),
    );

  const message = await respond(interaction, pages[index], [buildRow()]);

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000,
    filter: (component) =>
      component.user.id === interaction.user.id && component.customId.endsWith(token),
  });

  collector.on('collect', async (component) => {
    index = component.customId.startsWith('next:')
      ? Math.min(index + 1, pages.length - 1)
      : Math.max(index - 1, 0);
    await component.update({ embeds: [pages[index]], components: [buildRow()] });
  });

  collector.on('end', async () => {
    await interaction.editReply({ components: [] }).catch(() => {});
  });

  return message;
}

/**
 * Renders a reconciliation plan as a preview embed: what would change, and what stands
 * in the way. Shown before any large synchronization runs.
 */
export function previewEmbed({
  title,
  summary,
  sampleActions = [],
  conflicts = [],
  warnings = [],
}) {
  const fields = [
    { name: 'Members reviewed', value: String(summary.membersReviewed ?? 1), inline: true },
    { name: 'Roles to add', value: String(summary.addCount ?? 0), inline: true },
    { name: 'Roles to remove', value: String(summary.removeCount ?? 0), inline: true },
    { name: 'Roles reviewed', value: String(summary.rolesReviewed ?? 0), inline: true },
    {
      name: 'Members missing from a guild',
      value: String(summary.guildsMissingMember ?? 0),
      inline: true,
    },
    { name: 'Estimated actions', value: String(summary.totalActions ?? 0), inline: true },
  ];

  if (sampleActions.length > 0) {
    fields.push({
      name: `Sample changes (${Math.min(sampleActions.length, 10)} of ${summary.totalActions})`,
      value: sampleActions
        .slice(0, 10)
        .map(
          (action) =>
            `${action.action === 'ADD_ROLE' ? '＋' : '－'} <@&${action.discordRoleId}> — ${truncate(action.reason, 60)}`,
        )
        .join('\n'),
    });
  }

  if (conflicts.length > 0) {
    fields.push({
      name: `Mapping conflicts (${conflicts.length})`,
      value: conflicts
        .slice(0, 5)
        .map((conflict) => `• ${truncate(conflict.message, 180)}`)
        .join('\n'),
    });
  }

  if (warnings.length > 0) {
    fields.push({
      name: `Warnings (${warnings.length})`,
      value: warnings
        .slice(0, 5)
        .map((warning) => `• ${truncate(warning.message, 180)}`)
        .join('\n'),
    });
  }

  return buildEmbed({
    title,
    description:
      summary.totalActions === 0
        ? 'Everything is already in the correct state. No changes are needed.'
        : 'Nothing has been changed yet. Review the plan below.',
    fields,
    color: summary.totalActions === 0 ? 'success' : 'warning',
  });
}
