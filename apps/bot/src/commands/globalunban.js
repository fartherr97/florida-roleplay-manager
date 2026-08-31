/**
 * `/globalunban` - lift a user's ban in every registered server at once.
 *
 * A server where the user was never banned is reported as skipped, not a failure. Gated
 * at system.manage; audited and posted to the mod-log webhook.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { formatSonoranResults, unbanGlobally } from '@frm/core';
import { successEmbed, truncate } from '../lib/ui.js';
import { memberOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('globalunban')
  .setDescription('Lift a user’s ban in every registered server')
  .addUserOption(memberOption(false))
  .addStringOption((option) =>
    option.setName('user_id').setDescription('User ID — usually a banned user is not in the server').setRequired(false),
  )
  .addStringOption((option) =>
    option.setName('reason').setDescription('Reason (recorded and logged)').setRequired(false),
  );

export async function execute(interaction, { ctx, gateway }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const rawId = interaction.options.getString('user_id');
  const targetId = user?.id ?? (rawId ? rawId.trim() : null);
  if (!targetId) {
    return interaction.editReply('Pick a member or give a user ID to unban.');
  }

  const result = await unbanGlobally(ctx, {
    discordUserId: targetId,
    reason: interaction.options.getString('reason') ?? undefined,
    gateway,
  });

  const lines = result.results.map((entry) => {
    if (entry.status === 'applied') return `Unbanned — ${entry.guild}`;
    if (entry.status === 'absent') return `Skipped — ${entry.guild}`;
    return `Failed — ${entry.guild}: ${entry.message}`;
  });

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Global unban',
        `Unbanned <@${targetId}> in ${result.applied} of ${result.total} registered servers.`,
        [
          { name: 'Per server', value: truncate(lines.join('\n') || '—') },
          ...(result.sonoran?.length
            ? [{ name: 'Sonoran', value: truncate(formatSonoranResults(result.sonoran, 'Unbanned').join('\n')) }]
            : []),
        ],
      ),
    ],
  });
}
