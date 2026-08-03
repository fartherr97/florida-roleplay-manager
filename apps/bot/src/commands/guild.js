/**
 * `/guild` - the approved guild allowlist.
 *
 * Registering and removing guilds are global-administrator actions; the authorization
 * check lives in `@frm/core`, not here.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  getGuildStatus,
  listGuilds,
  registerGuild,
  removeGuild,
  updateGuildSettings,
} from '@frm/core';
import { GuildType } from '@frm/shared';
import {
  buildEmbed,
  orDash,
  paginate,
  requestConfirmation,
  successEmbed,
  truncate,
} from '../lib/ui.js';
import { guildOption, reasonOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('guild')
  .setDescription('Manage the approved Discord server allowlist')
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List approved Discord servers')
      .addStringOption((option) =>
        option
          .setName('type')
          .setDescription('Filter by guild type')
          .addChoices(...Object.values(GuildType).map((value) => ({ name: value, value })))
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('register')
      .setDescription('Add this or another Discord server to the allowlist')
      .addStringOption((option) =>
        option
          .setName('guild_id')
          .setDescription('Discord server ID (defaults to this server)')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('type')
          .setDescription('What kind of server this is')
          .addChoices(...Object.values(GuildType).map((value) => ({ name: value, value })))
          .setRequired(false),
      )
      .addStringOption((option) =>
        option.setName('name').setDescription('Display name').setRequired(false),
      )
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a Discord server from the allowlist')
      .addStringOption(guildOption(true))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('settings')
      .setDescription('Change a server settings')
      .addStringOption(guildOption(true))
      .addBooleanOption((option) =>
        option.setName('enabled').setDescription('Is the guild active?').setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('sync_enabled')
          .setDescription('Should roles be synchronized here?')
          .setRequired(false),
      )
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Live health of an approved server')
      .addStringOption(guildOption(false)),
  );

export async function execute(interaction, { ctx, gateway }) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'list':
      return handleList(interaction, ctx);
    case 'register':
      return handleRegister(interaction, ctx, gateway);
    case 'remove':
      return handleRemove(interaction, ctx);
    case 'settings':
      return handleSettings(interaction, ctx);
    case 'status':
      return handleStatus(interaction, ctx, gateway);
    default:
      throw new Error(`Unknown subcommand ${sub}`);
  }
}

async function handleList(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const type = interaction.options.getString('type');
  const page = await listGuilds(ctx, { pageSize: 10, ...(type ? { type } : {}) });

  if (page.items.length === 0) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'No approved servers', color: 'neutral' })],
    });
  }

  const embed = buildEmbed({
    title: `Approved servers (${page.pagination.total})`,
    fields: page.items.map((guild) => ({
      name: `${guild.enabled ? '✅' : '⛔'} ${guild.name}`,
      value: [
        `Type: ${guild.type}`,
        `ID: \`${guild.discordGuildId}\``,
        `Department: ${orDash(guild.department?.abbreviation)}`,
        `Sync: ${guild.syncEnabled ? 'on' : 'off'}`,
        `Managed roles: ${guild._count.managedRoles}`,
        `Mappings: ${guild._count.sourceMappings + guild._count.targetMappings}`,
      ].join('\n'),
      inline: true,
    })),
  });

  return interaction.editReply({ embeds: [embed] });
}

async function handleRegister(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const discordGuildId = interaction.options.getString('guild_id') ?? interaction.guildId;
  const name =
    interaction.options.getString('name') ??
    (discordGuildId === interaction.guildId ? interaction.guild.name : discordGuildId);

  const { guild, warnings } = await registerGuild(
    ctx,
    {
      discordGuildId,
      name,
      type: interaction.options.getString('type') ?? GuildType.DEPARTMENT,
      reason: interaction.options.getString('reason') ?? 'Registered from Discord',
    },
    { gateway },
  );

  return interaction.editReply({
    embeds: [
      successEmbed('Server approved', `**${guild.name}** is now on the approved allowlist.`, [
        { name: 'Guild ID', value: `\`${guild.discordGuildId}\``, inline: true },
        { name: 'Type', value: guild.type, inline: true },
        {
          name: 'Synchronization',
          value: guild.syncEnabled ? 'Enabled' : 'Disabled',
          inline: true,
        },
        ...(warnings.length > 0
          ? [{ name: 'Warnings', value: warnings.map((w) => `• ${w}`).join('\n') }]
          : []),
      ]),
    ],
  });
}

async function handleRemove(interaction, ctx) {
  const guildId = interaction.options.getString('guild');
  const reason = interaction.options.getString('reason');

  const confirmed = await requestConfirmation(interaction, {
    title: 'Remove this server from the allowlist?',
    description:
      'Every mapping involving this server will be disabled and no further synchronization ' +
      'will happen there. Nothing is removed from Discord.',
    confirmLabel: 'Remove server',
  });
  if (!confirmed) return undefined;

  const result = await removeGuild(ctx, { guildId, reason });

  return interaction.editReply({
    embeds: [
      successEmbed('Server removed', `**${result.guild.name}** is no longer approved.`, [
        { name: 'Mappings disabled', value: String(result.disabledMappings), inline: true },
      ]),
    ],
    components: [],
  });
}

async function handleSettings(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const enabled = interaction.options.getBoolean('enabled');
  const syncEnabled = interaction.options.getBoolean('sync_enabled');

  const guild = await updateGuildSettings(ctx, {
    guildId: interaction.options.getString('guild'),
    ...(enabled === null ? {} : { enabled }),
    ...(syncEnabled === null ? {} : { syncEnabled }),
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [
      successEmbed('Settings updated', `**${guild.name}** has been updated.`, [
        { name: 'Enabled', value: guild.enabled ? 'yes' : 'no', inline: true },
        { name: 'Synchronization', value: guild.syncEnabled ? 'on' : 'off', inline: true },
      ]),
    ],
  });
}

async function handleStatus(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildRef = interaction.options.getString('guild');
  let guildId = guildRef;

  if (!guildId) {
    const page = await listGuilds(ctx, { search: interaction.guildId, pageSize: 1 });
    guildId = page.items[0]?.id;
    if (!guildId) {
      return interaction.editReply({
        embeds: [
          buildEmbed({
            title: 'Not found',
            description:
              'This server is approved but could not be looked up. Try passing it explicitly.',
            color: 'warning',
          }),
        ],
      });
    }
  }

  const status = await getGuildStatus(ctx, { guildId }, { gateway });

  const embed = buildEmbed({
    title: `Status: ${status.guild.name}`,
    color: status.problems.length === 0 ? 'success' : 'warning',
    fields: [
      { name: 'Enabled', value: status.guild.enabled ? 'yes' : 'no', inline: true },
      { name: 'Synchronization', value: status.guild.syncEnabled ? 'on' : 'off', inline: true },
      { name: 'Type', value: status.guild.type, inline: true },
      { name: 'Bot present', value: status.live.botPresent ? 'yes' : 'no', inline: true },
      {
        name: 'Manage Roles',
        value: status.live.botCanManageRoles ? 'yes' : 'no',
        inline: true,
      },
      {
        name: 'Bot role position',
        value: String(status.live.botHighestRolePosition ?? '—'),
        inline: true,
      },
      { name: 'Managed roles', value: String(status.counts.managedRoles), inline: true },
      { name: 'Mappings', value: String(status.counts.mappings), inline: true },
      { name: 'Open issues', value: String(status.counts.openIssues), inline: true },
      ...(status.problems.length > 0
        ? [
            {
              name: `Problems (${status.problems.length})`,
              value: truncate(status.problems.map((problem) => `• ${problem}`).join('\n')),
            },
          ]
        : []),
    ],
  });

  return paginate(interaction, [embed]);
}
