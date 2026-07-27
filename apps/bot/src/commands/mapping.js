/**
 * `/mapping` - cross-guild role mappings.
 *
 * Creating and enabling both run the full validation chain in `@frm/core`: allowlist,
 * both-sided authorization, live role checks, protection policy and cycle detection.
 * A rejected mapping always explains what conflicted.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  approvePending,
  createMapping,
  deleteMapping,
  getMapping,
  listMappings,
  listPendingApprovals,
  rejectPending,
  setMappingEnabled,
  testMapping,
  updateMapping,
} from '@frm/core';
import { AuthoritySource, MappingDirection } from '@frm/shared';
import { buildEmbed, orDash, requestConfirmation, successEmbed, truncate } from '../lib/ui.js';
import { guildOption, mappingOption, reasonOption } from '../lib/options.js';

const directionChoices = Object.values(MappingDirection).map((value) => ({ name: value, value }));
const authorityChoices = Object.values(AuthoritySource).map((value) => ({ name: value, value }));

export const data = new SlashCommandBuilder()
  .setName('mapping')
  .setDescription('Manage cross-guild role mappings')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a role mapping between two approved servers')
      .addStringOption((option) =>
        option.setName('name').setDescription('A name for this mapping').setRequired(true),
      )
      .addStringOption(guildOption(true, 'source_guild', 'Server the role comes from'))
      .addStringOption((option) =>
        option
          .setName('source_role')
          .setDescription('Role in the source server')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption(guildOption(true, 'target_guild', 'Server the role is applied in'))
      .addStringOption((option) =>
        option
          .setName('target_role')
          .setDescription('Role in the target server')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option
          .setName('direction')
          .setDescription('ONE_WAY (default) or TWO_WAY')
          .addChoices(...directionChoices)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('authority')
          .setDescription('Which system decides the correct value')
          .addChoices(...authorityChoices)
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('sync_add')
          .setDescription('Propagate additions (default true)')
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('sync_remove')
          .setDescription('Propagate removals (default true)')
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName('priority')
          .setDescription('Higher priority wins a conflict (default 100)')
          .setMinValue(0)
          .setMaxValue(1000)
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('enabled')
          .setDescription('Activate immediately after validation (default false)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List role mappings')
      .addBooleanOption((option) =>
        option.setName('enabled_only').setDescription('Only enabled mappings').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('view').setDescription('View one mapping').addStringOption(mappingOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Change a mapping settings')
      .addStringOption(mappingOption(true))
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option
          .setName('direction')
          .setDescription('Mapping direction')
          .addChoices(...directionChoices)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('authority')
          .setDescription('Authority source')
          .addChoices(...authorityChoices)
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('sync_add').setDescription('Propagate additions').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('sync_remove').setDescription('Propagate removals').setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName('priority')
          .setDescription('Conflict priority')
          .setMinValue(0)
          .setMaxValue(1000)
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('test')
      .setDescription('Validate a mapping without changing anything')
      .addStringOption(mappingOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('enable')
      .setDescription('Enable a mapping (re-validates first)')
      .addStringOption(mappingOption(true))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('disable')
      .setDescription('Disable a mapping')
      .addStringOption(mappingOption(true))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Delete a mapping')
      .addStringOption(mappingOption(true))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub.setName('approvals').setDescription('List mappings awaiting a second approver'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('approve')
      .setDescription('Approve a protected mapping raised by somebody else')
      .addStringOption((option) =>
        option.setName('approval_id').setDescription('The approval request id').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('comment').setDescription('Optional note').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reject')
      .setDescription('Reject a pending mapping approval')
      .addStringOption((option) =>
        option.setName('approval_id').setDescription('The approval request id').setRequired(true),
      )
      .addStringOption(reasonOption(true)),
  );

export async function execute(interaction, { ctx, gateway }) {
  switch (interaction.options.getSubcommand()) {
    case 'create':
      return handleCreate(interaction, ctx, gateway);
    case 'list':
      return handleList(interaction, ctx);
    case 'view':
      return handleView(interaction, ctx);
    case 'edit':
      return handleEdit(interaction, ctx, gateway);
    case 'test':
      return handleTest(interaction, ctx, gateway);
    case 'enable':
    case 'disable':
      return handleToggle(interaction, ctx, gateway);
    case 'remove':
      return handleRemove(interaction, ctx);
    case 'approvals':
      return handleApprovals(interaction, ctx);
    case 'approve':
      return handleApprove(interaction, ctx);
    case 'reject':
      return handleReject(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

/** Turns the ApprovedGuild UUIDs chosen by autocomplete back into Discord snowflakes. */
async function resolveGuildSnowflakes(ctx, sourceGuildRef, targetGuildRef) {
  const guilds = await ctx.prisma.approvedGuild.findMany({
    where: { id: { in: [sourceGuildRef, targetGuildRef] } },
    select: { id: true, discordGuildId: true },
  });
  const byId = new Map(guilds.map((guild) => [guild.id, guild.discordGuildId]));
  return {
    sourceGuildId: byId.get(sourceGuildRef) ?? sourceGuildRef,
    targetGuildId: byId.get(targetGuildRef) ?? targetGuildRef,
  };
}

async function handleCreate(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { sourceGuildId, targetGuildId } = await resolveGuildSnowflakes(
    ctx,
    interaction.options.getString('source_guild'),
    interaction.options.getString('target_guild'),
  );

  const syncAdd = interaction.options.getBoolean('sync_add');
  const syncRemove = interaction.options.getBoolean('sync_remove');
  const enabled = interaction.options.getBoolean('enabled');

  const { mapping, warnings, requiresApproval } = await createMapping(
    ctx,
    {
      name: interaction.options.getString('name'),
      sourceGuildId,
      sourceRoleId: interaction.options.getString('source_role'),
      targetGuildId,
      targetRoleId: interaction.options.getString('target_role'),
      direction: interaction.options.getString('direction') ?? MappingDirection.ONE_WAY,
      authority: interaction.options.getString('authority') ?? AuthoritySource.SOURCE_DISCORD,
      ...(syncAdd === null ? {} : { syncAdd }),
      ...(syncRemove === null ? {} : { syncRemove }),
      ...(enabled === null ? {} : { enabled }),
      priority: interaction.options.getInteger('priority') ?? 100,
      reason: interaction.options.getString('reason'),
    },
    { gateway },
  );

  return interaction.editReply({
    embeds: [
      successEmbed('Mapping created', `**${mapping.name}**`, [
        { name: 'Direction', value: mapping.direction, inline: true },
        { name: 'Authority', value: mapping.authority, inline: true },
        { name: 'Enabled', value: mapping.enabled ? 'yes' : 'no', inline: true },
        { name: 'Add sync', value: mapping.syncAdd ? 'on' : 'off', inline: true },
        { name: 'Removal sync', value: mapping.syncRemove ? 'on' : 'off', inline: true },
        { name: 'Priority', value: String(mapping.priority), inline: true },
        ...(requiresApproval
          ? [
              {
                name: 'Second approver required',
                value:
                  'This mapping touches a protected role and stays disabled until it is approved.',
              },
            ]
          : []),
        ...(warnings.length > 0
          ? [{ name: 'Warnings', value: truncate(warnings.map((w) => `• ${w}`).join('\n')) }]
          : []),
      ]),
    ],
  });
}

async function handleList(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const enabledOnly = interaction.options.getBoolean('enabled_only');
  const page = await listMappings(ctx, {
    pageSize: 10,
    ...(enabledOnly ? { enabled: true } : {}),
  });

  if (page.items.length === 0) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'No mappings configured', color: 'neutral' })],
    });
  }

  const embed = buildEmbed({
    title: `Role mappings (${page.pagination.total})`,
    fields: page.items.map((mapping) => ({
      name: `${mapping.enabled ? '●' : '○'} ${mapping.name}`,
      value: [
        `${mapping.sourceGuild.name} <@&${mapping.sourceRoleId}>`,
        `${mapping.direction === MappingDirection.TWO_WAY ? '↔' : '→'} ${mapping.targetGuild.name} <@&${mapping.targetRoleId}>`,
        `Authority: ${mapping.authority} · Priority: ${mapping.priority}`,
      ].join('\n'),
    })),
    footer: `Page ${page.pagination.page} of ${page.pagination.totalPages}`,
  });

  return interaction.editReply({ embeds: [embed] });
}

async function handleView(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const mapping = await getMapping(ctx, interaction.options.getString('mapping'));

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: mapping.name,
        color: mapping.enabled ? 'success' : 'neutral',
        fields: [
          {
            name: 'Source',
            value: `${mapping.sourceGuild.name}\n<@&${mapping.sourceRoleId}>`,
            inline: true,
          },
          {
            name: 'Target',
            value: `${mapping.targetGuild.name}\n<@&${mapping.targetRoleId}>`,
            inline: true,
          },
          { name: 'Direction', value: mapping.direction, inline: true },
          { name: 'Authority', value: mapping.authority, inline: true },
          { name: 'Add sync', value: mapping.syncAdd ? 'on' : 'off', inline: true },
          { name: 'Removal sync', value: mapping.syncRemove ? 'on' : 'off', inline: true },
          { name: 'Enabled', value: mapping.enabled ? 'yes' : 'no', inline: true },
          { name: 'Priority', value: String(mapping.priority), inline: true },
          {
            name: 'Requires approval',
            value: mapping.requiresApproval ? (mapping.approvedAt ? 'approved' : 'pending') : 'no',
            inline: true,
          },
          { name: 'Created by', value: orDash(mapping.createdBy?.displayName), inline: true },
          { name: 'Actions applied', value: String(mapping._count.syncActions), inline: true },
          { name: 'Open issues', value: String(mapping._count.syncIssues), inline: true },
        ],
        footer: `Mapping ID: ${mapping.id}`,
      }),
    ],
  });
}

async function handleEdit(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const syncAdd = interaction.options.getBoolean('sync_add');
  const syncRemove = interaction.options.getBoolean('sync_remove');
  const priority = interaction.options.getInteger('priority');

  const mapping = await updateMapping(
    ctx,
    {
      mappingId: interaction.options.getString('mapping'),
      direction: interaction.options.getString('direction') ?? undefined,
      authority: interaction.options.getString('authority') ?? undefined,
      ...(syncAdd === null ? {} : { syncAdd }),
      ...(syncRemove === null ? {} : { syncRemove }),
      ...(priority === null ? {} : { priority }),
      reason: interaction.options.getString('reason'),
    },
    { gateway },
  );

  return interaction.editReply({
    embeds: [
      successEmbed('Mapping updated', `**${mapping.name}** has been updated.`, [
        { name: 'Direction', value: mapping.direction, inline: true },
        { name: 'Authority', value: mapping.authority, inline: true },
        { name: 'Priority', value: String(mapping.priority), inline: true },
      ]),
    ],
  });
}

async function handleTest(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await testMapping(
    ctx,
    { mappingId: interaction.options.getString('mapping') },
    { gateway },
  );

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: result.ok ? 'Mapping is healthy' : 'Mapping has problems',
        color: result.ok ? 'success' : 'warning',
        description: result.ok
          ? 'Both guilds are approved, both roles exist and the bot can manage them.'
          : 'The following need attention before this mapping can be trusted.',
        fields: [
          ...(result.roles
            ? [
                {
                  name: 'Source role',
                  value: `${result.roles.source.name} (position ${result.roles.source.position})`,
                  inline: true,
                },
                {
                  name: 'Target role',
                  value: `${result.roles.target.name} (position ${result.roles.target.position})`,
                  inline: true,
                },
              ]
            : []),
          ...(result.problems.length > 0
            ? [
                {
                  name: `Problems (${result.problems.length})`,
                  value: truncate(result.problems.map((problem) => `• ${problem}`).join('\n')),
                },
              ]
            : []),
        ],
      }),
    ],
  });
}

async function handleToggle(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const enabled = interaction.options.getSubcommand() === 'enable';

  const mapping = await setMappingEnabled(
    ctx,
    {
      mappingId: interaction.options.getString('mapping'),
      enabled,
      reason: interaction.options.getString('reason'),
    },
    { gateway },
  );

  return interaction.editReply({
    embeds: [
      successEmbed(
        enabled ? 'Mapping enabled' : 'Mapping disabled',
        `**${mapping.name}** is now ${enabled ? 'active' : 'inactive'}.`,
        enabled
          ? [
              {
                name: 'Next step',
                value:
                  'Existing members are not changed until a resync runs. Use `/resync guild` or wait for scheduled reconciliation.',
              },
            ]
          : [],
      ),
    ],
  });
}

async function handleRemove(interaction, ctx) {
  const mappingId = interaction.options.getString('mapping');
  const reason = interaction.options.getString('reason');

  const confirmed = await requestConfirmation(interaction, {
    title: 'Delete this mapping?',
    description:
      'The mapping stops applying immediately. Roles already granted through it are left in ' +
      'place until the next reconciliation decides otherwise.',
    confirmLabel: 'Delete mapping',
  });
  if (!confirmed) return undefined;

  const mapping = await deleteMapping(ctx, { mappingId, reason });

  return interaction.editReply({
    embeds: [successEmbed('Mapping deleted', `**${mapping.name}** has been removed.`)],
    components: [],
  });
}

async function handleApprovals(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const approvals = await listPendingApprovals(ctx);

  if (approvals.length === 0) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'Nothing awaiting approval', color: 'success' })],
    });
  }

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: `Awaiting a second approver (${approvals.length})`,
        color: 'warning',
        fields: approvals.slice(0, 10).map((approval) => ({
          name: approval.mapping?.name ?? approval.type,
          value: truncate(
            [
              `Requested by ${approval.requestedBy.displayName}`,
              approval.mapping
                ? `${approval.mapping.sourceGuild.name} → ${approval.mapping.targetGuild.name}`
                : null,
              `Votes: ${approval.votes.filter((vote) => vote.approve).length}/${approval.requiredApprovals}`,
              `Expires <t:${Math.floor(new Date(approval.expiresAt).getTime() / 1000)}:R>`,
              `ID: \`${approval.id}\``,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        })),
        footer: 'Approve with /mapping approve approval_id:<id>',
      }),
    ],
  });
}

async function handleApprove(interaction, ctx) {
  const approvalId = interaction.options.getString('approval_id');

  const confirmed = await requestConfirmation(interaction, {
    title: 'Approve this protected mapping?',
    description:
      'You are acting as the second authorized approver. The mapping can be enabled once approved.',
    confirmLabel: 'Approve',
    danger: false,
  });
  if (!confirmed) return undefined;

  const result = await approvePending(ctx, {
    approvalId,
    comment: interaction.options.getString('comment') ?? undefined,
  });

  return interaction.editReply({
    embeds: [
      successEmbed(
        result.applied ? 'Approved' : 'Vote recorded',
        result.applied
          ? 'The mapping has been signed off and can now be enabled with /mapping enable.'
          : `Recorded. ${result.approvals} of ${result.approval.requiredApprovals} approvals so far.`,
      ),
    ],
    components: [],
  });
}

async function handleReject(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await rejectPending(ctx, {
    approvalId: interaction.options.getString('approval_id'),
    reason: interaction.options.getString('reason'),
  });

  return interaction.editReply({
    embeds: [successEmbed('Rejected', 'The mapping will not be activated.')],
  });
}
