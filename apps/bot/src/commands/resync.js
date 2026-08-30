/**
 * `/resync` - synchronization commands.
 *
 * Resync just runs. No dry run, no preview, no confirmation gate: the operator asks for a
 * sync and gets one, and the reply says whether it succeeded and which roles were added in
 * which guild. The heavy safety net still lives server side — a job that would remove an
 * unsafe number of roles pauses itself — so "just run it" stays safe without a preview step.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getSyncJob, resyncAll, resyncGuild, resyncMember, waitForJob } from '@frm/core';
import { SyncActionType } from '@frm/shared';
import { buildEmbed, orDash, truncate } from '../lib/ui.js';
import { guildOption, memberOption, reasonOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('resync')
  .setDescription('Synchronize Discord roles with the platform')
  .addSubcommand((sub) =>
    sub
      .setName('member')
      .setDescription('Resynchronize one member')
      .addUserOption(memberOption(true))
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
      .setName('status')
      .setDescription('Check a synchronization job')
      .addStringOption((option) =>
        option.setName('job_id').setDescription('The job id').setRequired(true),
      ),
  );

export async function execute(interaction, { ctx }) {
  switch (interaction.options.getSubcommand()) {
    case 'member':
      return handleMember(interaction, ctx);
    case 'guild':
      return handleGuild(interaction, ctx);
    case 'all':
      return handleAll(interaction, ctx);
    case 'status':
      return handleStatus(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

async function handleMember(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const { job } = await resyncMember(ctx, {
    discordUserId: user.id,
    displayName: user.globalName ?? user.username ?? undefined,
    dryRun: false,
    reason: interaction.options.getString('reason') ?? undefined,
  });

  const finished = await waitForJob(job.id, { timeoutMs: 20000 });
  return interaction.editReply({
    embeds: [await resultEmbed(ctx, finished ?? job, { subject: user.tag })],
  });
}

async function handleGuild(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.options.getString('guild');
  const reason = interaction.options.getString('reason') ?? undefined;

  const { job } = await resyncGuild(ctx, { guildId, dryRun: false, reason });
  const finished = await waitForJob(job.id, { timeoutMs: 60000 });
  return interaction.editReply({ embeds: [await resultEmbed(ctx, finished ?? job)] });
}

async function handleAll(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = interaction.options.getString('reason');
  const { job } = await resyncAll(ctx, { dryRun: false, reason });
  const finished = await waitForJob(job.id, { timeoutMs: 90000 });
  return interaction.editReply({ embeds: [await resultEmbed(ctx, finished ?? job)] });
}

async function handleStatus(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const job = await getSyncJob(ctx, interaction.options.getString('job_id'), { actionLimit: 200 });
  return interaction.editReply({ embeds: [await resultEmbed(ctx, job)] });
}

/**
 * The whole reply: did it succeed, and which roles were added in which guild.
 *
 * A job that is still running (a large one that outlived the wait) is reported as running
 * rather than as a result, so the operator knows to check its status rather than assuming
 * nothing happened.
 */
async function resultEmbed(ctx, job, { subject } = {}) {
  const full = job.actions ? job : await getSyncJob(ctx, job.id, { actionLimit: 200 });
  const status = full.status;

  if (status === 'PENDING' || status === 'RUNNING') {
    return buildEmbed({
      title: 'Resync running',
      description: `Job \`${full.id}\` is still working. Check it with \`/resync status\`.`,
      color: 'info',
      footer: orDash(full.reason),
    });
  }

  const actions = full.actions ?? [];
  const added = actions.filter(
    (action) => action.action === SyncActionType.ADD_ROLE && action.status === 'APPLIED',
  );
  const removed = actions.filter(
    (action) => action.action === SyncActionType.REMOVE_ROLE && action.status === 'APPLIED',
  );
  const failed = actions.filter((action) => action.status === 'FAILED');

  const succeeded = (status === 'COMPLETED' || status === 'PARTIAL') && failed.length === 0;

  const base = succeeded
    ? {
        title: 'Resync successful',
        color: full.thresholdBreached ? 'warning' : 'success',
      }
    : {
        title: 'Resync unsuccessful',
        color: status === 'PAUSED' || full.thresholdBreached ? 'warning' : 'danger',
      };

  const fields = [];

  if (added.length > 0) {
    fields.push(...rolesAddedByGuildFields(added));
  }
  if (removed.length > 0) {
    fields.push({ name: 'Roles removed', value: String(removed.length), inline: true });
  }
  if (failed.length > 0) {
    fields.push({ name: 'Failed', value: String(failed.length), inline: true });
  }
  if (full.thresholdBreached) {
    fields.push({
      name: 'Paused for safety',
      value:
        'The job would have removed more roles than the safety threshold allows, so it was paused.',
    });
  }
  fields.push({ name: 'Job ID', value: `\`${full.id}\`` });

  const description =
    added.length === 0 && removed.length === 0 && succeeded
      ? subject
        ? `${subject} was already in order — no role changes were needed.`
        : 'Everyone was already in order — no role changes were needed.'
      : subject
        ? `Member: ${subject}`
        : undefined;

  return buildEmbed({ ...base, description, fields, footer: orDash(full.reason) });
}

/** One field per guild listing the roles that were added there. */
function rolesAddedByGuildFields(added) {
  const byGuild = new Map();
  for (const action of added) {
    const key = action.guild?.name ?? action.discordGuildId;
    if (!byGuild.has(key)) byGuild.set(key, []);
    byGuild.get(key).push(`<@&${action.discordRoleId}>`);
  }

  // Discord caps an embed at 25 fields; leave room for the summary/id fields.
  return [...byGuild.entries()].slice(0, 20).map(([guildName, roles]) => ({
    name: `Roles added — ${guildName}`,
    value: truncate(roles.join(' '), 1000),
  }));
}
