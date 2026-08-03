/**
 * `/permissions` - granting and revoking platform capabilities.
 *
 * Every escalation rule is enforced in `@frm/authorization`: you cannot grant what you
 * do not hold, cannot exceed your own ceilings, and cannot grant to yourself.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { grantPermission, listPermissions, revokePermission } from '@frm/core';
import { PermissionScopeType } from '@frm/shared';
import { buildEmbed, orDash, requestConfirmation, successEmbed, truncate } from '../lib/ui.js';
import { memberOption, reasonOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('permissions')
  .setDescription('Platform permission management')
  .addSubcommand((sub) =>
    sub
      .setName('grant')
      .setDescription('Grant a capability to a member')
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option
          .setName('capability')
          .setDescription('The capability to grant')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('scope_type')
          .setDescription('Where the capability applies')
          .addChoices(
            ...Object.values(PermissionScopeType).map((value) => ({ name: value, value })),
          )
          .setRequired(true),
      )
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option
          .setName('guild')
          .setDescription('Guild scope (required unless GLOBAL)')
          .setRequired(false)
          .setAutocomplete(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('max_authority')
          .setDescription('Highest authority level they may manage')
          .setMinValue(0)
          .setMaxValue(100)
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('revoke')
      .setDescription('Revoke a permission assignment')
      .addStringOption((option) =>
        option
          .setName('assignment_id')
          .setDescription('Assignment id (from /permissions view)')
          .setRequired(true),
      )
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('View permission assignments')
      .addUserOption(memberOption(false)),
  );

export async function execute(interaction, { ctx }) {
  switch (interaction.options.getSubcommand()) {
    case 'grant':
      return handleGrant(interaction, ctx);
    case 'revoke':
      return handleRevoke(interaction, ctx);
    case 'view':
      return handleView(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

async function handleGrant(interaction, ctx) {
  const user = interaction.options.getUser('member');
  const capability = interaction.options.getString('capability');
  const scopeType = interaction.options.getString('scope_type');
  const scopeId =
    scopeType === PermissionScopeType.GUILD ? interaction.options.getString('guild') : undefined;

  const maxAuthority = interaction.options.getInteger('max_authority');

  const confirmed = await requestConfirmation(interaction, {
    title: 'Grant this permission?',
    description: `<@${user.id}> will be able to use **${capability}**.`,
    fields: [
      { name: 'Scope', value: `${scopeType}${scopeId ? ` (${scopeId})` : ''}`, inline: true },
      { name: 'Max authority', value: orDash(maxAuthority), inline: true },
    ],
    confirmLabel: 'Grant permission',
    danger: false,
  });
  if (!confirmed) return undefined;

  const assignment = await grantPermission(ctx, {
    discordUserId: user.id,
    capability,
    scopeType,
    ...(scopeId ? { scopeId } : {}),
    ...(maxAuthority === null ? {} : { maxPermissionLevel: maxAuthority }),
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [
      successEmbed('Permission granted', `<@${user.id}> now has **${capability}**.`, [
        { name: 'Assignment ID', value: `\`${assignment.id}\`` },
      ]),
    ],
    components: [],
  });
}

async function handleRevoke(interaction, ctx) {
  const assignmentId = interaction.options.getString('assignment_id');

  const confirmed = await requestConfirmation(interaction, {
    title: 'Revoke this permission?',
    description: `Assignment \`${assignmentId}\` will stop applying immediately.`,
    confirmLabel: 'Revoke permission',
  });
  if (!confirmed) return undefined;

  const assignment = await revokePermission(ctx, {
    assignmentId,
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [
      successEmbed('Permission revoked', `**${assignment.capabilityKey}** has been revoked.`),
    ],
    components: [],
  });
}

async function handleView(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser('member');

  const page = await listPermissions(ctx, {
    ...(user ? { discordUserId: user.id } : {}),
    pageSize: 20,
  });

  if (page.items.length === 0) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'No permission assignments', color: 'neutral' })],
    });
  }

  const lines = page.items.map(
    (assignment) =>
      `**${assignment.capabilityKey}** — ${assignment.scopeLabel}\n` +
      `> holder: ${assignment.user.displayName} · authority ceiling: ${orDash(assignment.maxPermissionLevel)}\n` +
      `> \`${assignment.id}\``,
  );

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: user
          ? `Permissions: ${user.tag}`
          : `Permission assignments (${page.pagination.total})`,
        description: truncate(lines.join('\n\n'), 4000),
        footer: `Page ${page.pagination.page} of ${page.pagination.totalPages}`,
      }),
    ],
  });
}
