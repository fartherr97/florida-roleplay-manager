/**
 * `/globalsetnickname` - set a member's Discord display name in every registered guild.
 *
 * A manual override: pick a member and a name, and the bot writes that nickname into
 * each approved server the member is in. Where a roster owns the nickname (sync on, a
 * bound rank held) the next reconciliation will rewrite it — the override sticks where
 * nothing else manages the name.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { setGlobalNickname } from '@frm/core';
import { successEmbed, truncate } from '../lib/ui.js';
import { memberOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('globalsetnickname')
  .setDescription('Set a member’s display name in every registered server')
  .addUserOption(memberOption(true))
  .addStringOption((option) =>
    option
      .setName('nickname')
      .setDescription('The display name to set (max 32 characters)')
      .setRequired(true)
      .setMaxLength(32),
  );

export async function execute(interaction, { ctx, gateway }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const nickname = interaction.options.getString('nickname');

  const result = await setGlobalNickname(ctx, {
    discordUserId: user.id,
    nickname,
    gateway,
  });

  const lines = result.results.map((entry) => {
    if (entry.status === 'applied') return `Set — ${entry.guild}`;
    if (entry.status === 'absent') return `Not in server — ${entry.guild}`;
    return `Failed — ${entry.guild}: ${entry.message}`;
  });

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Nickname set',
        `Set <@${user.id}>'s display name to **${result.nickname}** in ` +
          `${result.applied} of ${result.total} registered servers.`,
        [{ name: 'Per server', value: truncate(lines.join('\n') || '—') }],
      ),
    ],
  });
}
