/**
 * `/setup` - one-command server provisioning.
 *
 * `/setup department` and `/setup community` each open a modal for the essentials, show a
 * preview of exactly what they will create (a dry run through the same engine), and only
 * touch Discord after the administrator confirms. Re-running is safe: anything that
 * already exists is skipped.
 */
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { createLogger, serializeError } from '@frm/logging';
import { provisionCommunity, provisionDepartment, resetGuildPermissions } from '@frm/core';
import { newRequestId } from '@frm/shared';
import { buildEmbed, renderError, requestConfirmation, successEmbed, truncate } from '../lib/ui.js';

const log = createLogger('bot.setup');

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Provision and configure a Discord server')
  .addSubcommand((sub) =>
    sub
      .setName('department')
      .setDescription('Create the channels, roles and permissions for a department server')
      .addBooleanOption((option) =>
        option
          .setName('wire_in')
          .setDescription('Also register the server and set up role sync (default: yes)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('community')
      .setDescription('Create the channels, roles and permissions for the main community server')
      .addBooleanOption((option) =>
        option
          .setName('wire_in')
          .setDescription('Also register the server as the community hub (default: yes)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('permissions')
      .setDescription(
        'Blank every role and give @everyone the basics, so access comes from channels',
      ),
  );

export async function execute(interaction, { ctx, gateway }) {
  switch (interaction.options.getSubcommand()) {
    case 'department':
      return runSetup(interaction, ctx, gateway, DEPARTMENT);
    case 'community':
      return runSetup(interaction, ctx, gateway, COMMUNITY);
    case 'permissions':
      return runPermissionsReset(interaction, ctx, gateway);
    default:
      throw new Error('Unknown subcommand');
  }
}

/** Per-subcommand configuration: what the modal asks and which service it calls. */
const DEPARTMENT = {
  label: 'department',
  modalTitle: 'Set up department server',
  fields: [
    {
      id: 'name',
      label: 'Department name',
      placeholder: "Hillsborough County Sheriff's Office",
      required: true,
      max: 100,
    },
    { id: 'tag', label: 'Role tag / abbreviation', placeholder: 'HCSO', required: true, max: 20 },
    {
      id: 'color',
      label: 'Role colour hex (optional)',
      placeholder: '#1F8B4C',
      required: false,
      max: 7,
    },
    {
      id: 'main_role',
      label: 'Main-community member role ID (optional)',
      placeholder: 'For auto-sync — the role in your main server',
      required: false,
      max: 20,
    },
  ],
  buildInput: (interaction, fields, wireIn) => ({
    discordGuildId: interaction.guildId,
    name: fields.getTextInputValue('name'),
    tag: fields.getTextInputValue('tag'),
    color: fields.getTextInputValue('color') || undefined,
    mainCommunityRoleId: fields.getTextInputValue('main_role') || undefined,
    wireIn,
  }),
  provision: provisionDepartment,
  wireInNote:
    'It will also register the server on the allowlist, mark its member role as managed, and (if you gave a main-community role) create the sync mapping.',
};

const COMMUNITY = {
  label: 'community',
  modalTitle: 'Set up community server',
  fields: [
    {
      id: 'name',
      label: 'Community name',
      placeholder: 'Florida Roleplay Community',
      required: true,
      max: 100,
    },
    {
      id: 'color',
      label: 'Role colour hex (optional)',
      placeholder: '#5865F2',
      required: false,
      max: 7,
    },
  ],
  buildInput: (interaction, fields, wireIn) => ({
    discordGuildId: interaction.guildId,
    name: fields.getTextInputValue('name'),
    color: fields.getTextInputValue('color') || undefined,
    wireIn,
  }),
  provision: provisionCommunity,
  wireInNote: 'It will also register this server on the allowlist as your main community hub.',
};

const inputRow = (input) => new ActionRowBuilder().addComponents(input);

async function runSetup(interaction, ctx, gateway, config) {
  const wireIn = interaction.options.getBoolean('wire_in') ?? true;

  const modalId = `setup-${config.label}:${randomUUID()}`;
  const modal = new ModalBuilder().setCustomId(modalId).setTitle(config.modalTitle);
  modal.addComponents(
    ...config.fields.map((field) =>
      inputRow(
        new TextInputBuilder()
          .setCustomId(field.id)
          .setLabel(field.label)
          .setPlaceholder(field.placeholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(field.required)
          .setMaxLength(field.max),
      ),
    ),
  );

  await interaction.showModal(modal);

  let submission;
  try {
    submission = await interaction.awaitModalSubmit({
      time: 2 * 60 * 1000,
      filter: (candidate) =>
        candidate.customId === modalId && candidate.user.id === interaction.user.id,
    });
  } catch {
    return undefined; // the modal timed out; nothing was created
  }

  await submission.deferReply({ flags: MessageFlags.Ephemeral });
  const requestId = newRequestId();
  const input = config.buildInput(interaction, submission.fields, wireIn);

  try {
    const preview = await config.provision(ctx, { ...input, dryRun: true }, { gateway });

    const confirmed = await requestConfirmation(submission, {
      title: `Set up ${preview.guild.name}?`,
      description: previewDescription(preview, wireIn, config),
      confirmLabel: 'Create it',
      danger: false,
    });
    if (!confirmed) return undefined;

    const result = await config.provision(ctx, { ...input, dryRun: false }, { gateway });
    return submission.editReply({ embeds: [resultEmbed(result, wireIn)], components: [] });
  } catch (error) {
    log.error(
      { err: serializeError(error), requestId, label: config.label },
      'setup provisioning failed',
    );
    return submission
      .editReply({ embeds: [renderError(error, requestId)], components: [] })
      .catch(() => {});
  }
}

async function runPermissionsReset(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const requestId = newRequestId();

  try {
    const preview = await resetGuildPermissions(
      ctx,
      { discordGuildId: interaction.guildId, dryRun: true },
      { gateway },
    );

    const confirmed = await requestConfirmation(interaction, {
      title: `Reset permissions in ${preview.guild.name}?`,
      description:
        `This will:\n` +
        `• give **@everyone** the basics — view channels, send messages, react, connect, ` +
        `speak, use commands, and so on\n` +
        `• **clear every permission** from **${preview.plan.toClear}** role(s) the bot can manage\n\n` +
        (preview.plan.skipped > 0
          ? `**${preview.plan.skipped}** role(s) above the bot or managed by an integration are left ` +
            `untouched.\n\n`
          : '') +
        `After this, access comes entirely from each channel's permissions. The server owner and ` +
        `the bot are unaffected — but any admin access that came from a role below the bot will be ` +
        `removed, so make sure you can still get in (owner, or an access tier).`,
      confirmLabel: 'Reset permissions',
      danger: true,
    });
    if (!confirmed) return undefined;

    const result = await resetGuildPermissions(
      ctx,
      { discordGuildId: interaction.guildId, dryRun: false },
      { gateway },
    );

    const fields = [
      { name: 'Roles cleared', value: String(result.cleared), inline: true },
      { name: 'Left untouched', value: String(result.skipped.length), inline: true },
    ];
    if (result.warnings.length) {
      fields.push({
        name: `Warnings (${result.warnings.length})`,
        value: truncate(result.warnings.map((warning) => `• ${warning}`).join('\n')),
      });
    }

    return interaction.editReply({
      embeds: [
        successEmbed(
          'Permissions reset',
          'Roles are blank and @everyone has the basics. Access now comes from channel permissions.',
          fields,
        ),
      ],
      components: [],
    });
  } catch (error) {
    log.error(
      { err: serializeError(error), requestId, discordGuildId: interaction.guildId },
      'setup permissions failed',
    );
    return interaction
      .editReply({ embeds: [renderError(error, requestId)], components: [] })
      .catch(() => {});
  }
}

function previewDescription(preview, wireIn, config) {
  const { toCreate } = preview.plan;
  const nothing = toCreate.roles + toCreate.categories + toCreate.channels === 0;

  const lines = [
    nothing
      ? 'Everything in the template already exists here — nothing new will be created.'
      : 'This will create:',
  ];
  if (!nothing) {
    if (toCreate.roles) lines.push(`• ${toCreate.roles} role(s)`);
    if (toCreate.categories) lines.push(`• ${toCreate.categories} categor(y/ies)`);
    if (toCreate.channels) lines.push(`• ${toCreate.channels} channel(s)`);
  }
  lines.push('', 'Anything already present is skipped — this is safe to re-run.');
  if (wireIn) lines.push('', config.wireInNote);
  return lines.join('\n');
}

function resultEmbed(result, wireIn) {
  const { created, wiredIn, warnings } = result;
  const fields = [
    {
      name: 'Created',
      value:
        [
          created.roles.length ? `Roles: ${created.roles.join(', ')}` : null,
          created.categories.length ? `Categories: ${created.categories.join(', ')}` : null,
          created.channels.length ? `Channels: ${created.channels.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n') || 'Nothing new — everything already existed.',
    },
  ];

  if (wireIn && wiredIn) {
    const platform = [`Registered on allowlist: ${wiredIn.registered ? 'yes' : 'no'}`];
    if ('managedRole' in wiredIn) {
      platform.push(`Member role managed: ${wiredIn.managedRole ? 'yes' : 'no'}`);
    }
    if ('mapping' in wiredIn) platform.push(`Sync mapping: ${wiredIn.mapping}`);
    fields.push({ name: 'Platform', value: platform.join('\n') });
  }

  if (warnings.length) {
    fields.push({
      name: `Warnings (${warnings.length})`,
      value: truncate(warnings.map((warning) => `• ${warning}`).join('\n')),
    });
  }

  return buildEmbed({
    title: `${result.guild.name} is set up`,
    description: 'Done. Re-run /setup any time to add anything that is missing.',
    color: warnings.length ? 'warning' : 'success',
    fields,
  });
}
