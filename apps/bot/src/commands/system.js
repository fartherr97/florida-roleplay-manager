/**
 * `/system health` - the first thing to check when "synchronization stopped working".
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getSystemHealth } from '@frm/core';
import { buildEmbed, truncate } from '../lib/ui.js';

export const data = new SlashCommandBuilder()
  .setName('system')
  .setDescription('Platform administration')
  .addSubcommand((sub) => sub.setName('health').setDescription('Show platform health'));

export async function execute(interaction, { ctx, gateway }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const health = await getSystemHealth(ctx, { gateway });

  const tick = (ok) => (ok ? '✅' : '❌');
  const issueLines = Object.entries(health.openIssues.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => `• ${type}: ${count}`)
    .join('\n');

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: health.healthy ? 'Platform healthy' : 'Platform degraded',
        color: health.healthy ? 'success' : 'danger',
        fields: [
          {
            name: 'Database',
            value: `${tick(health.database.ok)} ${health.database.latencyMs ?? '—'}ms`,
            inline: true,
          },
          {
            name: 'Redis',
            value: `${tick(health.redis.ok)} ${health.redis.latencyMs ?? '—'}ms`,
            inline: true,
          },
          {
            name: 'Discord',
            value: `${tick(health.discord.ok)} ${health.discord.guildCount ?? '—'} guild(s)`,
            inline: true,
          },
          {
            name: 'Queues',
            value: health.queues.ok
              ? Object.entries(health.queues.stats)
                  .map(
                    ([name, counts]) =>
                      `${name}: ${counts.waiting ?? 0} waiting, ${counts.active ?? 0} active, ${counts.failed ?? 0} failed`,
                  )
                  .join('\n')
              : '❌ unreachable',
          },
          {
            name: 'Platform',
            value: [
              `Guilds: ${health.counts.guilds}`,
              `Members: ${health.counts.members}`,
              `Mappings: ${health.counts.enabledMappings}/${health.counts.mappings} enabled`,
              `Managed roles: ${health.counts.managedRoles}`,
            ].join('\n'),
            inline: true,
          },
          {
            name: 'Jobs',
            value: [
              `Running too long: ${health.stuckJobs.runningTooLong}`,
              `Paused: ${health.stuckJobs.paused}`,
              `Pending too long: ${health.stuckJobs.pendingTooLong}`,
            ].join('\n'),
            inline: true,
          },
          {
            name: `Open issues (${health.openIssues.total})`,
            value: truncate(issueLines || 'None'),
          },
          {
            name: 'Mode',
            value: [
              `Environment: ${health.mode.nodeEnv}`,
              `Development mode: ${health.mode.devMode ? 'ON' : 'off'}`,
              `Discord mock: ${health.mode.discordMock ? 'ON' : 'off'}`,
              `Dry run default: ${health.mode.dryRunDefault ? 'ON' : 'off'}`,
              `Removal threshold: ${health.mode.maxRemovalsThreshold}`,
              `Marker TTL: ${health.mode.markerTtlSeconds}s`,
            ].join('\n'),
          },
        ],
        footer: `Checked in ${health.checkedInMs}ms`,
      }),
    ],
  });
}
