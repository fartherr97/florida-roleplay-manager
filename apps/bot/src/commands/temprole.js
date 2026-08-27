/**
 * `/temprole` - give a member a Discord role for a set amount of time, then take it back off.
 *
 * A direct, temporary role assignment — the role does not need to be declared managed, and
 * reconciliation never touches it. `add` applies the role now in this server and records a
 * timer; a maintenance sweep removes it once the duration passes. `remove` takes it back off
 * early. Gated at grant.issue; every use is audited and posted to the mod-log webhook.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { addTempRole, removeTempRole } from '@frm/core';
import { parseDuration, formatDuration } from '@frm/shared';
import { buildEmbed, successEmbed } from '../lib/ui.js';
import { memberOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('temprole')
  .setDescription('Give a member a role for a set duration, then remove it')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a role to a member for a set duration')
      .addUserOption(memberOption(true))
      .addRoleOption((option) =>
        option.setName('role').setDescription('The role to add temporarily').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How long, e.g. 6h, 7d, 30m, 1d12h')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('Reason (recorded and logged)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Take a temporary role back off a member early')
      .addUserOption(memberOption(true))
      .addRoleOption((option) =>
        option.setName('role').setDescription('The role to remove').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('Reason (recorded and logged)').setRequired(false),
      ),
  );

export async function execute(interaction, { ctx, gateway }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guildId) {
    return interaction.editReply('Use this command inside a server.');
  }

  const user = interaction.options.getUser('member');
  const role = interaction.options.getRole('role');
  const guildName = interaction.guild?.name ?? undefined;

  if (interaction.options.getSubcommand() === 'add') {
    // Throws a friendly validation error on a typo, which the interaction handler renders.
    const durationMs = parseDuration(interaction.options.getString('duration'));
    if (!(durationMs > 0)) {
      return interaction.editReply({
        embeds: [
          buildEmbed({
            title: 'How long?',
            description: 'Give a duration like `6h`, `7d`, `30m`, or `1d12h`.',
            color: 'warning',
          }),
        ],
      });
    }

    const result = await addTempRole(ctx, {
      discordGuildId: interaction.guildId,
      guildName,
      discordUserId: user.id,
      discordRoleId: role.id,
      roleName: role.name,
      durationMs,
      reason: interaction.options.getString('reason') ?? undefined,
      gateway,
    });

    return interaction.editReply({
      embeds: [
        successEmbed(
          'Temporary role added',
          `<@${user.id}> now has <@&${role.id}> for **${formatDuration(durationMs)}**.`,
          [
            {
              name: 'Expires',
              value: `<t:${Math.floor(result.expiresAt.getTime() / 1000)}:R>`,
              inline: true,
            },
            { name: 'Removed automatically', value: "Yes — you don't need to do anything.", inline: true },
          ],
        ),
      ],
    });
  }

  const result = await removeTempRole(ctx, {
    discordGuildId: interaction.guildId,
    guildName,
    discordUserId: user.id,
    discordRoleId: role.id,
    reason: interaction.options.getString('reason') ?? undefined,
    gateway,
  });

  const note = result.applied
    ? `<@&${role.id}> has been removed from <@${user.id}>.`
    : result.failure
      ? `Closed the timer, but the role could not be removed: ${result.failure}.`
      : `<@${user.id}> no longer had the role — the timer is closed.`;

  return interaction.editReply({
    embeds: [
      successEmbed('Temporary role removed', note, [
        { name: 'Pending timer', value: result.found ? 'Cancelled.' : 'None was active.', inline: true },
      ]),
    ],
  });
}
