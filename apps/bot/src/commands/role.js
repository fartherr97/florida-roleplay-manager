/**
 * `/role` - managed role definitions and manual grants.
 *
 * Declaring a role as managed is the single most consequential piece of configuration
 * in the platform: it is what moves a Discord role from "the member's own business" into
 * "something reconciliation may remove". Both destructive paths therefore confirm first.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  issueGrant,
  listGrants,
  listManagedRoles,
  removeManagedRole,
  revokeGrant,
  upsertManagedRole,
} from '@frm/core';
import { RolePurpose } from '@frm/shared';
import { buildEmbed, orDash, requestConfirmation, successEmbed, truncate } from '../lib/ui.js';
import { guildOption, memberOption, reasonOption } from '../lib/options.js';

const purposeChoices = Object.values(RolePurpose).map((value) => ({ name: value, value }));

export const data = new SlashCommandBuilder()
  .setName('role')
  .setDescription('Managed roles and manual grants')
  .addSubcommand((sub) =>
    sub
      .setName('manage')
      .setDescription('Declare a Discord role as managed by the platform')
      // Discord requires every required option before the optional ones, so `reason`
      // (required) comes ahead of the optional role/purpose/protection options.
      .addStringOption(guildOption(true))
      .addStringOption(reasonOption(true))
      .addRoleOption((option) =>
        option
          .setName('discord_role')
          .setDescription('The role, when it is in this server')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('role_id')
          .setDescription('Role ID, when the role is in another server')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('purpose')
          .setDescription('MAPPING (default), MANUAL_GRANT, or OTHER for hands-off')
          .addChoices(...purposeChoices)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('protection')
          .setDescription('Protection level')
          .addChoices(
            { name: 'NONE', value: 'NONE' },
            { name: 'ELEVATED', value: 'ELEVATED' },
            { name: 'TWO_PERSON', value: 'TWO_PERSON' },
          )
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List managed roles').addStringOption(guildOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unmanage')
      .setDescription('Stop managing a role (the Discord role itself is untouched)')
      .addStringOption((option) =>
        option
          .setName('managed_role_id')
          .setDescription('Managed role id, from /role list')
          .setRequired(true),
      )
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('grant')
      .setDescription('Give a member a managed role until it is revoked or expires')
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option
          .setName('managed_role_id')
          .setDescription('Managed role id, from /role list')
          .setRequired(true),
      )
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option.setName('expires').setDescription('Expiry date (YYYY-MM-DD)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('revoke')
      .setDescription('Revoke a manual role grant')
      .addStringOption((option) =>
        option.setName('grant_id').setDescription('Grant id, from /role grants').setRequired(true),
      )
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('grants')
      .setDescription('List manual role grants')
      .addUserOption(memberOption(false)),
  );

export async function execute(interaction, { ctx, gateway }) {
  switch (interaction.options.getSubcommand()) {
    case 'manage':
      return handleManage(interaction, ctx, gateway);
    case 'list':
      return handleList(interaction, ctx);
    case 'unmanage':
      return handleUnmanage(interaction, ctx);
    case 'grant':
      return handleGrant(interaction, ctx, gateway);
    case 'revoke':
      return handleRevoke(interaction, ctx);
    case 'grants':
      return handleGrants(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

async function handleManage(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('discord_role');
  const roleId = role?.id ?? interaction.options.getString('role_id');
  if (!roleId) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'Which role?',
          description: 'Pass either a role from this server or a role ID from another one.',
          color: 'warning',
        }),
      ],
    });
  }

  const managed = await upsertManagedRole(
    ctx,
    {
      guildId: interaction.options.getString('guild'),
      discordRoleId: roleId,
      name: role?.name ?? `Role ${roleId}`,
      purpose: interaction.options.getString('purpose') ?? RolePurpose.MAPPING,
      protectionLevel: interaction.options.getString('protection') ?? 'NONE',
      reason: interaction.options.getString('reason'),
    },
    { gateway },
  );

  return interaction.editReply({
    embeds: [
      successEmbed('Role is now managed', `<@&${managed.discordRoleId}>`, [
        { name: 'Purpose', value: managed.purpose, inline: true },
        { name: 'Protection', value: managed.protectionLevel, inline: true },
        { name: 'Managed role ID', value: `\`${managed.id}\`` },
        {
          name: 'What this means',
          value:
            managed.purpose === RolePurpose.OTHER
              ? 'The platform knows about this role but will never add or remove it.'
              : 'Reconciliation may now add and remove this role for members.',
        },
      ]),
    ],
  });
}

async function handleList(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.options.getString('guild');
  const page = await listManagedRoles(ctx, { ...(guildId ? { guildId } : {}), pageSize: 25 });

  if (page.items.length === 0) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'No managed roles', color: 'neutral' })],
    });
  }

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: `Managed roles (${page.pagination.total})`,
        description: truncate(
          page.items
            .map(
              (role) =>
                `<@&${role.discordRoleId}> — **${role.purpose}**` +
                `${role.protectionLevel === 'NONE' ? '' : ` · ${role.protectionLevel}`}` +
                `${role.managedByPlatform ? '' : ' · hands-off'}\n` +
                `> ${role.guild.name} · grants: ${role._count.manualGrants} · \`${role.id}\``,
            )
            .join('\n'),
          4000,
        ),
        footer: `Page ${page.pagination.page} of ${page.pagination.totalPages}`,
      }),
    ],
  });
}

async function handleUnmanage(interaction, ctx) {
  const confirmed = await requestConfirmation(interaction, {
    title: 'Stop managing this role?',
    description:
      'The Discord role is left exactly as it is. The platform simply stops considering it ' +
      'its business, which also means it will never remove it from anybody again.',
    confirmLabel: 'Stop managing',
  });
  if (!confirmed) return undefined;

  await removeManagedRole(ctx, {
    managedRoleId: interaction.options.getString('managed_role_id'),
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [successEmbed('No longer managed', 'The role definition has been removed.')],
    components: [],
  });
}

async function handleGrant(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const result = await issueGrant(
    ctx,
    {
      discordUserId: user.id,
      managedRoleId: interaction.options.getString('managed_role_id'),
      expiresAt: interaction.options.getString('expires') ?? undefined,
      reason: interaction.options.getString('reason'),
    },
    { gateway },
  );

  return interaction.editReply({
    embeds: [
      successEmbed('Grant issued', `<@${user.id}> will receive the role shortly.`, [
        {
          name: 'Expires',
          value: result.grant.expiresAt
            ? `<t:${Math.floor(new Date(result.grant.expiresAt).getTime() / 1000)}:R>`
            : 'never',
          inline: true,
        },
        { name: 'Grant ID', value: `\`${result.grant.id}\``, inline: true },
        { name: 'Synchronization', value: `Job \`${result.syncJob.id}\`` },
      ]),
    ],
  });
}

async function handleRevoke(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await revokeGrant(ctx, {
    grantId: interaction.options.getString('grant_id'),
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [
      successEmbed('Grant revoked', 'The role will be removed at the next synchronization.', [
        { name: 'Synchronization', value: `Job \`${result.syncJob.id}\`` },
      ]),
    ],
  });
}

async function handleGrants(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const page = await listGrants(ctx, {
    ...(user ? { discordUserId: user.id } : {}),
    pageSize: 25,
  });

  if (page.items.length === 0) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'No active grants', color: 'neutral' })],
    });
  }

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: user ? `Grants: ${user.tag}` : `Active grants (${page.pagination.total})`,
        description: truncate(
          page.items
            .map(
              (grant) =>
                `<@&${grant.managedRole.discordRoleId}> in ${grant.managedRole.guild.name}\n` +
                `> ${grant.user.displayName} · by ${orDash(grant.grantedBy?.displayName)} · ` +
                `${grant.expiresAt ? `expires <t:${Math.floor(new Date(grant.expiresAt).getTime() / 1000)}:R>` : 'no expiry'}\n` +
                `> \`${grant.id}\``,
            )
            .join('\n'),
          4000,
        ),
        footer: `Page ${page.pagination.page} of ${page.pagination.totalPages}`,
      }),
    ],
  });
}
