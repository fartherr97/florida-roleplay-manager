/**
 * `/globalbansync` — backfill the website's ban list from Discord.
 *
 * The website's Staff Hub ban list is fed by `/globalban` going forward, but
 * bans placed before that existed aren't on it. This reads every current ban
 * across all registered servers, de-duplicates by user, and reports each to the
 * website so the list matches Discord. Read-only in Discord — it bans nobody,
 * it only mirrors what's already there. Gated at system.manage, like the rest of
 * the global moderation commands.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { syncGlobalBans } from '@frm/core';
import { getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { errorEmbed, successEmbed, truncate } from '../lib/ui.js';
import { reportBan } from '../lib/siteBans.js';

const log = createLogger('bot.globalbansync');

export const data = new SlashCommandBuilder()
  .setName('globalbansync')
  .setDescription("Backfill the website's ban list from every server's current Discord bans");

export async function execute(interaction, { ctx, gateway }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const env = getEnv();
  if (!env.WEBSITE_API_URL || !env.WEBSITE_BOT_TOKEN) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Website not connected',
          'The ban list lives on the website, which is not configured yet. Ask an administrator to set ' +
            '`WEBSITE_API_URL` and `WEBSITE_BOT_TOKEN`.',
        ),
      ],
    });
  }

  // authorize() inside the service enforces system.manage and throws a friendly
  // error the interaction handler renders if the caller isn't allowed.
  const result = await syncGlobalBans(ctx, { gateway });

  const actorName = interaction.member?.displayName ?? interaction.user.username;
  let reported = 0;
  let failed = 0;
  for (const ban of result.bans) {
    try {
      await reportBan({
        discordId: ban.discordUserId,
        displayName: ban.displayName,
        reason: ban.reason,
        actorId: interaction.user.id,
        actorName,
        serversApplied: ban.guildCount,
        serversTotal: result.guildsTotal,
        expiresAt: ban.expiresAt,
      });
      reported += 1;
    } catch (error) {
      failed += 1;
      log.warn({ err: serializeError(error), discordId: ban.discordUserId }, 'ban sync report failed');
    }
  }

  const notes = [];
  if (result.guildsFailed > 0) {
    notes.push(`${result.guildsFailed} of ${result.guildsTotal} servers couldn't be read (check the bot's Ban Members permission there).`);
  }
  if (failed > 0) notes.push(`${failed} bans failed to report to the website.`);

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Ban list synced',
        `Read ${result.guildsRead} of ${result.guildsTotal} servers and sent ${reported} unique ban${reported === 1 ? '' : 's'} to the website's ban list.`,
        [
          { name: 'Unique bans found', value: String(result.total), inline: true },
          { name: 'Reported', value: String(reported), inline: true },
          ...(notes.length ? [{ name: 'Notes', value: truncate(notes.join('\n')) }] : []),
        ],
      ),
    ],
  });
}
