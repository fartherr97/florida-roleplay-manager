/**
 * `/member` - member lookup and Discord account linking.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { linkMember, lookupMember, unlinkMember } from '@frm/core';
import { buildEmbed, orDash, requestConfirmation, successEmbed, truncate } from '../lib/ui.js';
import { memberOption, reasonOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('member')
  .setDescription('Community member records')
  .addSubcommand((sub) =>
    sub.setName('lookup').setDescription('Look up a member').addUserOption(memberOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('link')
      .setDescription('Link a Discord account to a platform member')
      .addUserOption(memberOption(true))
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option
          .setName('display_name')
          .setDescription('Name to use for a brand new member record')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unlink')
      .setDescription('Unlink a Discord account')
      .addUserOption(memberOption(true))
      .addStringOption(reasonOption(true)),
  );

export async function execute(interaction, { ctx }) {
  switch (interaction.options.getSubcommand()) {
    case 'lookup':
      return handleLookup(interaction, ctx);
    case 'link':
      return handleLink(interaction, ctx);
    case 'unlink':
      return handleUnlink(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

async function handleLookup(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const profile = await lookupMember(ctx, { discordUserId: user.id });

  const grants = profile.grants.length
    ? profile.grants
        .map(
          (grant) =>
            `<@&${grant.managedRole.discordRoleId}> in ${grant.managedRole.guild.name}` +
            `${grant.expiresAt ? ` · expires <t:${Math.floor(new Date(grant.expiresAt).getTime() / 1000)}:R>` : ''}`,
        )
        .join('\n')
    : '—';

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: profile.user.displayName,
        description: profile.user.primaryDiscordId
          ? `<@${profile.user.primaryDiscordId}>`
          : undefined,
        fields: [
          { name: 'Status', value: profile.user.status, inline: true },
          { name: 'Authority level', value: String(profile.user.permissionLevel), inline: true },
          {
            name: 'Website access',
            value: profile.user.websiteAccess ? 'yes' : 'no',
            inline: true,
          },
          { name: 'Active role grants', value: truncate(grants) },
          {
            name: 'Permissions',
            value: truncate(
              profile.permissions.map((entry) => entry.capabilityKey).join(', ') || '—',
            ),
          },
          { name: 'Open sync issues', value: String(profile.openIssues), inline: true },
          {
            name: 'Linked accounts',
            value:
              profile.identities.map((identity) => `<@${identity.discordUserId}>`).join(', ') ||
              '—',
            inline: true,
          },
        ],
        footer: `Member ID: ${profile.user.id}`,
      }),
    ],
  });
}

async function handleLink(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const result = await linkMember(ctx, {
    discordUserId: user.id,
    displayName: interaction.options.getString('display_name') ?? user.username,
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Account linked',
        `<@${user.id}> is now linked to **${result.user.displayName}**.`,
        [{ name: 'Member ID', value: `\`${result.user.id}\`` }],
      ),
    ],
  });
}

async function handleUnlink(interaction, ctx) {
  const user = interaction.options.getUser('member');

  const confirmed = await requestConfirmation(interaction, {
    title: `Unlink ${user.tag}?`,
    description:
      'The Discord account stops being associated with the platform member. Their record ' +
      'is untouched, but they can no longer be synchronized through this account.',
    confirmLabel: 'Unlink account',
  });
  if (!confirmed) return undefined;

  const result = await unlinkMember(ctx, {
    discordUserId: user.id,
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [
      successEmbed('Account unlinked', `<@${user.id}> is no longer linked.`, [
        { name: 'Remaining primary account', value: orDash(result.user.primaryDiscordId) },
      ]),
    ],
    components: [],
  });
}
