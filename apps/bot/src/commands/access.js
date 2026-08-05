/**
 * `/access` - map main-guild Discord roles to authority tiers.
 *
 * Holding a mapped role makes a member that tier and grants every command up to it,
 * resolved live from their Discord roles. Editing runs from the main community server so the
 * role picker offers the right roles; the whole thing needs the `access.manage` capability,
 * which only global administrators hold.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { listAccessTiers, removeAccessTier, setAccessTier } from '@frm/core';
import { buildEmbed, renderError, successEmbed, truncate } from '../lib/ui.js';
import { reasonOption } from '../lib/options.js';

/** The authority tiers a role may be mapped to, and their display names. */
const TIER_CHOICES = [
  { name: 'Supervisor', value: 20 },
  { name: 'Command', value: 40 },
  { name: 'Manager', value: 60 },
  { name: 'Staff', value: 80 },
  { name: 'Admin (full access)', value: 100 },
];
const TIER_NAME = new Map(TIER_CHOICES.map((choice) => [choice.value, choice.name]));
const tierName = (level) => TIER_NAME.get(level) ?? `level ${level}`;

export const data = new SlashCommandBuilder()
  .setName('access')
  .setDescription('Grant bot access by Discord role')
  .addSubcommand((sub) =>
    sub
      .setName('grant')
      .setDescription('Map a main-server role to an authority tier')
      .addRoleOption((option) =>
        option.setName('role').setDescription('The main-server role to map').setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('tier')
          .setDescription('The tier its holders get (unlocks every command up to it)')
          .addChoices(...TIER_CHOICES)
          .setRequired(true),
      )
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('revoke')
      .setDescription('Remove a role -> tier mapping')
      .addRoleOption((option) =>
        option.setName('role').setDescription('The mapped role').setRequired(true),
      )
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show the current role -> tier mappings'),
  );

export async function execute(interaction, { ctx }) {
  switch (interaction.options.getSubcommand()) {
    case 'grant':
      return handleGrant(interaction, ctx);
    case 'revoke':
      return handleRevoke(interaction, ctx);
    case 'list':
      return handleList(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

async function handleGrant(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('role');
  const level = interaction.options.getInteger('tier');

  try {
    await setAccessTier(ctx, {
      discordRoleId: role.id,
      roleName: role.name,
      level,
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Access mapped',
        `Anyone with <@&${role.id}> now has the **${tierName(level)}** tier and every command ` +
          'up to it, for as long as they hold the role.',
        [
          { name: 'Role', value: `<@&${role.id}>`, inline: true },
          { name: 'Tier', value: `${tierName(level)} (${level})`, inline: true },
        ],
      ),
    ],
  });
}

async function handleRevoke(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('role');

  let result;
  try {
    result = await removeAccessTier(ctx, {
      discordRoleId: role.id,
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  return interaction.editReply({
    embeds: [
      result.removed
        ? successEmbed('Access removed', `<@&${role.id}> no longer grants any tier.`)
        : buildEmbed({
            title: 'Nothing to remove',
            description: `<@&${role.id}> was not mapped to a tier.`,
            color: 'neutral',
          }),
    ],
  });
}

async function handleList(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tiers = await listAccessTiers(ctx);
  if (tiers.length === 0) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'No access roles configured',
          description: 'Map one with `/access grant` from your main community server.',
          color: 'neutral',
        }),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: 'Discord-role access',
        description: truncate(
          tiers
            .map((tier) => `<@&${tier.discordRoleId}> → **${tierName(tier.permissionLevel)}**`)
            .join('\n'),
          4000,
        ),
        color: 'info',
        footer: 'Holders get every command up to their tier, live from their Discord roles.',
      }),
    ],
  });
}
