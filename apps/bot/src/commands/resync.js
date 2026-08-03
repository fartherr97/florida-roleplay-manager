/**
 * `/resync` - synchronization commands.
 *
 * Anything that touches more than one member runs a dry run first, shows the preview,
 * and only then asks for confirmation. That ordering is deliberate: the number an
 * operator needs to see before approving a guild-wide change is "how many roles will
 * actually be removed", and the only trustworthy source of that number is the same
 * planner that will do the work.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  getSyncJob,
  resolveUser,
  resyncAll,
  resyncGuild,
  resyncMember,
  waitForJob,
} from '@frm/core';
import { SyncActionType } from '@frm/shared';
import { planForUser, summarizePlan } from '@frm/reconciliation';
import {
  buildEmbed,
  orDash,
  previewEmbed,
  requestConfirmation,
  successEmbed,
  truncate,
} from '../lib/ui.js';
import { dryRunOption, guildOption, memberOption, reasonOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('resync')
  .setDescription('Synchronize Discord roles with the platform')
  .addSubcommand((sub) =>
    sub
      .setName('member')
      .setDescription('Resynchronize one member')
      .addUserOption(memberOption(true))
      .addBooleanOption(dryRunOption)
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('guild')
      .setDescription('Resynchronize every managed member of a server')
      .addStringOption(guildOption(true))
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('all')
      .setDescription('Resynchronize the entire platform')
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('preview')
      .setDescription('Show what a resynchronization would change, without applying it')
      .addUserOption(memberOption(false))
      .addStringOption(guildOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Check a synchronization job')
      .addStringOption((option) =>
        option.setName('job_id').setDescription('The job id').setRequired(true),
      ),
  );

export async function execute(interaction, { ctx, gateway }) {
  switch (interaction.options.getSubcommand()) {
    case 'member':
      return handleMember(interaction, ctx);
    case 'guild':
      return handleGuild(interaction, ctx);
    case 'all':
      return handleAll(interaction, ctx);
    case 'preview':
      return handlePreview(interaction, ctx, gateway);
    case 'status':
      return handleStatus(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

async function handleMember(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const dryRun = interaction.options.getBoolean('dry_run');

  const { job } = await resyncMember(ctx, {
    discordUserId: user.id,
    ...(dryRun === null ? {} : { dryRun }),
    reason: interaction.options.getString('reason') ?? undefined,
  });

  const finished = await waitForJob(job.id, { timeoutMs: 20000 });
  return interaction.editReply({ embeds: [await jobEmbed(ctx, finished ?? job, user.tag)] });
}

async function handleGuild(interaction, ctx) {
  const guildId = interaction.options.getString('guild');
  const reason = interaction.options.getString('reason') ?? undefined;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { job: dryJob } = await resyncGuild(ctx, { guildId, dryRun: true, reason });
  const finishedDry = await waitForJob(dryJob.id, { timeoutMs: 60000 });
  const summary = await summarizeJob(ctx, (finishedDry ?? dryJob).id);

  if (summary.totalActions === 0) {
    return interaction.editReply({
      embeds: [
        successEmbed('Nothing to do', 'Every managed member already has the correct roles.'),
      ],
    });
  }

  const confirmed = await requestConfirmation(interaction, {
    title: 'Apply these changes to the whole server?',
    description: `${summary.addCount} additions and ${summary.removeCount} removals are planned.`,
    fields: previewFields(summary),
    confirmLabel: `Apply ${summary.totalActions} changes`,
  });
  if (!confirmed) return undefined;

  const { job } = await resyncGuild(ctx, { guildId, dryRun: false, reason });
  return interaction.editReply({
    embeds: [successEmbed('Guild resynchronization queued', `Job \`${job.id}\` is running.`)],
    components: [],
  });
}

async function handleAll(interaction, ctx) {
  const reason = interaction.options.getString('reason');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { job: dryJob } = await resyncAll(ctx, { dryRun: true, reason });
  const finishedDry = await waitForJob(dryJob.id, { timeoutMs: 90000 });
  const summary = await summarizeJob(ctx, (finishedDry ?? dryJob).id);

  const confirmed = await requestConfirmation(interaction, {
    title: 'Resynchronize the entire platform?',
    description:
      'This reconciles every active member in every approved guild. ' +
      `The preview found ${summary.addCount} additions and ${summary.removeCount} removals.`,
    fields: previewFields(summary),
    confirmLabel: 'Resynchronize everything',
  });
  if (!confirmed) return undefined;

  const { job } = await resyncAll(ctx, { dryRun: false, reason });
  return interaction.editReply({
    embeds: [
      successEmbed(
        'Global resynchronization queued',
        `Job \`${job.id}\` is running. Large jobs pause automatically if they would remove an unsafe number of roles.`,
      ),
    ],
    components: [],
  });
}

async function handlePreview(interaction, ctx, gateway) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const guildId = interaction.options.getString('guild');

  if (!user && !guildId) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'Choose what to preview',
          description: 'Pass a member or a guild.',
          color: 'warning',
        }),
      ],
    });
  }

  // A single member is planned inline: it is a handful of API calls and the operator
  // gets an answer immediately instead of waiting on the queue.
  if (user) {
    const target = await resolveUser(ctx, { discordUserId: user.id });
    const result = await planForUser({ gateway, userId: target.id, prisma: ctx.prisma });

    if (!result) {
      return interaction.editReply({
        embeds: [buildEmbed({ title: 'Member not found', color: 'warning' })],
      });
    }

    const summary = summarizePlan(result.plan);
    return interaction.editReply({
      embeds: [
        previewEmbed({
          title: `Preview: ${user.tag}`,
          summary: { ...summary, membersReviewed: 1 },
          sampleActions: result.plan.actions,
          conflicts: result.plan.conflicts,
          warnings: result.plan.warnings,
        }),
      ],
    });
  }

  const { job } = await resyncGuild(ctx, { guildId, dryRun: true });
  const finished = await waitForJob(job.id, { timeoutMs: 60000 });
  const summary = await summarizeJob(ctx, (finished ?? job).id);

  return interaction.editReply({
    embeds: [
      previewEmbed({
        title: 'Preview: guild resynchronization',
        summary,
        sampleActions: summary.sampleActions,
        conflicts: [],
        warnings: [],
      }),
    ],
  });
}

async function handleStatus(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const job = await getSyncJob(ctx, interaction.options.getString('job_id'));
  return interaction.editReply({ embeds: [await jobEmbed(ctx, job)] });
}

/** Reads a finished dry-run job back into preview numbers. */
async function summarizeJob(ctx, jobId) {
  const job = await getSyncJob(ctx, jobId, { actionLimit: 200 });
  const actions = job.actions ?? [];
  const adds = actions.filter((action) => action.action === SyncActionType.ADD_ROLE);
  const removes = actions.filter((action) => action.action === SyncActionType.REMOVE_ROLE);

  return {
    jobId: job.id,
    status: job.status,
    totalActions: job._count?.actions ?? actions.length,
    addCount: adds.length,
    removeCount: removes.length,
    membersReviewed: job.progressTotal,
    membersWithChanges: new Set(actions.map((action) => action.discordUserId)).size,
    rolesReviewed: actions.length,
    guildsMissingMember: (job.issues ?? []).filter((issue) => issue.type === 'MEMBER_NOT_IN_GUILD')
      .length,
    conflictCount: (job.issues ?? []).filter((issue) => issue.type === 'MAPPING_CONFLICT').length,
    issues: job.issues ?? [],
    sampleActions: actions,
  };
}

function previewFields(summary) {
  return [
    { name: 'Members reviewed', value: String(summary.membersReviewed ?? 0), inline: true },
    { name: 'Members changing', value: String(summary.membersWithChanges ?? 0), inline: true },
    { name: 'Roles to add', value: String(summary.addCount ?? 0), inline: true },
    { name: 'Roles to remove', value: String(summary.removeCount ?? 0), inline: true },
    { name: 'Missing from a guild', value: String(summary.guildsMissingMember ?? 0), inline: true },
    { name: 'Mapping conflicts', value: String(summary.conflictCount ?? 0), inline: true },
  ];
}

async function jobEmbed(ctx, job, subject) {
  const full = job.actions ? job : await getSyncJob(ctx, job.id, { actionLimit: 25 });
  const actions = full.actions ?? [];
  const applied = actions.filter((action) => action.status === 'APPLIED');
  const failed = actions.filter((action) => action.status === 'FAILED');
  const dryRun = actions.filter((action) => action.status === 'DRY_RUN');

  const colorFor = {
    COMPLETED: 'success',
    PARTIAL: 'warning',
    PAUSED: 'warning',
    FAILED: 'danger',
    CANCELLED: 'neutral',
  };

  return buildEmbed({
    title: `${full.dryRun ? 'Dry run' : 'Synchronization'}: ${full.status}`,
    description: subject ? `Member: ${subject}` : undefined,
    color: colorFor[full.status] ?? 'info',
    fields: [
      { name: 'Type', value: full.type, inline: true },
      { name: 'Members', value: String(full.progressTotal), inline: true },
      { name: 'Applied', value: String(applied.length), inline: true },
      { name: 'Failed', value: String(failed.length), inline: true },
      { name: 'Planned (dry run)', value: String(dryRun.length), inline: true },
      { name: 'Open issues', value: String((full.issues ?? []).length), inline: true },
      ...(actions.length > 0
        ? [
            {
              name: 'Changes',
              value: truncate(
                actions
                  .slice(0, 10)
                  .map(
                    (action) =>
                      `${action.action === SyncActionType.ADD_ROLE ? '＋' : '－'} <@&${action.discordRoleId}> — ${action.reason}`,
                  )
                  .join('\n') || '—',
              ),
            },
          ]
        : []),
      ...((full.issues ?? []).length > 0
        ? [
            {
              name: 'Issues',
              value: truncate(
                full.issues
                  .slice(0, 5)
                  .map((issue) => `• ${issue.message}`)
                  .join('\n'),
              ),
            },
          ]
        : []),
      { name: 'Job ID', value: `\`${full.id}\`` },
      ...(full.thresholdBreached
        ? [
            {
              name: 'Paused',
              value:
                'This job was paused because it would have removed more roles than the safety threshold allows.',
            },
          ]
        : []),
    ],
    footer: orDash(full.reason),
  });
}
