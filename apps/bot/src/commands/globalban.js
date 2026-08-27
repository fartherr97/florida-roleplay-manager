/**
 * `/globalban` - ban a user from every registered server at once.
 *
 * Works by user id, so it applies whether or not the user is still a member — a raid
 * account that already left is still banned. Gated at system.manage; every use is audited
 * and posted to the mod-log webhook.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { banGlobally } from '@frm/core';
import { parseDuration } from '@frm/shared';
import { successEmbed, truncate } from '../lib/ui.js';
import { memberOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('globalban')
  .setDescription('Ban a user from every registered server')
  .addUserOption(memberOption(false))
  .addStringOption((option) =>
    option.setName('user_id').setDescription('User ID — for someone not in this server').setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName('duration')
      .setDescription('How long, e.g. 7d, 6h, 30m, 1d12h — leave blank for permanent')
      .setRequired(false),
  )
  .addStringOption((option) =>
    option.setName('reason').setDescription('Reason (recorded and logged)').setRequired(false),
  )
  .addIntegerOption((option) =>
    option
      .setName('delete_days')
      .setDescription('Delete this many days of their recent messages (0–7)')
      .setMinValue(0)
      .setMaxValue(7)
      .setRequired(false),
  );

export async function execute(interaction, { ctx, gateway }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const rawId = interaction.options.getString('user_id');
  const targetId = user?.id ?? (rawId ? rawId.trim() : null);
  if (!targetId) {
    return interaction.editReply('Pick a member or give a user ID to ban.');
  }

  // Throws a friendly validation error on a typo, which the interaction handler renders.
  const durationMs = parseDuration(interaction.options.getString('duration'));

  const result = await banGlobally(ctx, {
    discordUserId: targetId,
    reason: interaction.options.getString('reason') ?? undefined,
    deleteMessageDays: interaction.options.getInteger('delete_days') ?? 0,
    durationMs,
    gateway,
  });

  const lines = result.results.map((entry) => {
    if (entry.status === 'applied') return `Banned — ${entry.guild}`;
    if (entry.status === 'absent') return `Skipped — ${entry.guild}`;
    return `Failed — ${entry.guild}: ${entry.message}`;
  });

  const until = result.expiresAt
    ? `until <t:${Math.floor(result.expiresAt.getTime() / 1000)}:R>`
    : 'permanently';

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Global ban',
        `Banned <@${targetId}> ${until} in ${result.applied} of ${result.total} registered servers.`,
        [{ name: 'Per server', value: truncate(lines.join('\n') || '—') }],
      ),
    ],
  });
}
