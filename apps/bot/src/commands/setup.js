/**
 * `/setup` - one-command server provisioning.
 *
 * `/setup department` opens a modal for the essentials, shows a preview of exactly what it
 * will create (a dry run through the same engine), and only touches Discord after the
 * administrator confirms. Re-running it is safe: anything that already exists is skipped.
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
import { provisionDepartment } from '@frm/core';
import { newRequestId } from '@frm/shared';
import { buildEmbed, renderError, requestConfirmation, truncate } from '../lib/ui.js';

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
  );

export async function execute(interaction, { ctx, gateway }) {
  if (interaction.options.getSubcommand() === 'department') {
    return handleDepartment(interaction, ctx, gateway);
  }
  throw new Error('Unknown subcommand');
}

const inputRow = (input) => new ActionRowBuilder().addComponents(input);

async function handleDepartment(interaction, ctx, gateway) {
  const wireIn = interaction.options.getBoolean('wire_in') ?? true;

  const modalId = `setup-dept:${randomUUID()}`;
  const modal = new ModalBuilder().setCustomId(modalId).setTitle('Set up department server');
  modal.addComponents(
    inputRow(
      new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Department name')
        .setPlaceholder("Hillsborough County Sheriff's Office")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100),
    ),
    inputRow(
      new TextInputBuilder()
        .setCustomId('tag')
        .setLabel('Role tag / abbreviation')
        .setPlaceholder('HCSO')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20),
    ),
    inputRow(
      new TextInputBuilder()
        .setCustomId('color')
        .setLabel('Role colour hex (optional)')
        .setPlaceholder('#1F8B4C')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(7),
    ),
    inputRow(
      new TextInputBuilder()
        .setCustomId('main_role')
        .setLabel('Main-community member role ID (optional)')
        .setPlaceholder('For auto-sync — the role in your main server')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(20),
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

  const input = {
    discordGuildId: interaction.guildId,
    name: submission.fields.getTextInputValue('name'),
    tag: submission.fields.getTextInputValue('tag'),
    color: submission.fields.getTextInputValue('color') || undefined,
    mainCommunityRoleId: submission.fields.getTextInputValue('main_role') || undefined,
    wireIn,
  };

  try {
    const preview = await provisionDepartment(ctx, { ...input, dryRun: true }, { gateway });

    const confirmed = await requestConfirmation(submission, {
      title: `Set up ${preview.guild.name}?`,
      description: previewDescription(preview, wireIn),
      confirmLabel: 'Create it',
      danger: false,
    });
    if (!confirmed) return undefined;

    const result = await provisionDepartment(ctx, { ...input, dryRun: false }, { gateway });
    return submission.editReply({ embeds: [resultEmbed(result, wireIn)], components: [] });
  } catch (error) {
    return submission
      .editReply({ embeds: [renderError(error, requestId)], components: [] })
      .catch(() => {});
  }
}

function previewDescription(preview, wireIn) {
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
  if (wireIn) {
    lines.push(
      '',
      'It will also register the server on the allowlist, mark its member role as managed, and (if you gave a main-community role) create the sync mapping.',
    );
  }
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
    fields.push({
      name: 'Platform',
      value: [
        `Registered on allowlist: ${wiredIn.registered ? 'yes' : 'no'}`,
        `Member role managed: ${wiredIn.managedRole ? 'yes' : 'no'}`,
        `Sync mapping: ${wiredIn.mapping}`,
      ].join('\n'),
    });
  }

  if (warnings.length) {
    fields.push({
      name: `Warnings (${warnings.length})`,
      value: truncate(warnings.map((warning) => `• ${warning}`).join('\n')),
    });
  }

  return buildEmbed({
    title: `${result.guild.name} is set up`,
    description: 'Done. Re-run /setup department any time to add anything that is missing.',
    color: warnings.length ? 'warning' : 'success',
    fields,
  });
}
