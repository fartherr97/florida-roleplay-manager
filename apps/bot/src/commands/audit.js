/**
 * `/audit` - the audit trail and unresolved synchronization failures.
 *
 * Read only by design: there is no command anywhere in this bot that edits or deletes an
 * audit record.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  auditForMapping,
  auditForMember,
  listSyncIssues,
  lookupMember,
  queryAuditLogs,
  retrySyncIssue,
} from '@frm/core';
import { SyncIssueType } from '@frm/shared';
import { buildEmbed, orDash, successEmbed, truncate } from '../lib/ui.js';
import { mappingOption, memberOption, pageOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('audit')
  .setDescription('Audit records and synchronization failures')
  .addSubcommand((sub) =>
    sub
      .setName('member')
      .setDescription('Audit records for one member')
      .addUserOption(memberOption(true))
      .addIntegerOption(pageOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('mapping')
      .setDescription('Audit records for one mapping')
      .addStringOption(mappingOption(true))
      .addIntegerOption(pageOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('recent')
      .setDescription('Most recent audit records')
      .addIntegerOption(pageOption)
      .addBooleanOption((option) =>
        option.setName('failures_only').setDescription('Only failed actions').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('failures')
      .setDescription('Unresolved synchronization failures')
      .addStringOption((option) =>
        option
          .setName('type')
          .setDescription('Filter by failure type')
          .addChoices(
            ...Object.values(SyncIssueType)
              .slice(0, 25)
              .map((value) => ({ name: value, value })),
          )
          .setRequired(false),
      )
      .addIntegerOption(pageOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('retry')
      .setDescription('Retry a failed synchronization action')
      .addStringOption((option) =>
        option.setName('issue_id').setDescription('The issue id').setRequired(true),
      ),
  );

export async function execute(interaction, { ctx }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const page = interaction.options.getInteger('page') ?? 1;

  switch (interaction.options.getSubcommand()) {
    case 'member': {
      const user = interaction.options.getUser('member');
      const profile = await lookupMember(ctx, { discordUserId: user.id });
      const result = await auditForMember(ctx, { userId: profile.user.id, page, pageSize: 10 });
      return interaction.editReply({
        embeds: [auditEmbed(`Audit: ${profile.user.displayName}`, result)],
      });
    }

    case 'mapping': {
      const result = await auditForMapping(ctx, {
        mappingId: interaction.options.getString('mapping'),
        page,
        pageSize: 10,
      });
      return interaction.editReply({ embeds: [auditEmbed('Audit: mapping', result)] });
    }

    case 'recent': {
      const failuresOnly = interaction.options.getBoolean('failures_only');
      const result = await queryAuditLogs(ctx, {
        page,
        pageSize: 10,
        ...(failuresOnly ? { success: false } : {}),
      });
      return interaction.editReply({ embeds: [auditEmbed('Recent audit records', result)] });
    }

    case 'failures': {
      const type = interaction.options.getString('type');
      const result = await listSyncIssues(ctx, {
        page,
        pageSize: 10,
        resolved: false,
        ...(type ? { type } : {}),
      });
      return interaction.editReply({ embeds: [issuesEmbed(result)] });
    }

    case 'retry': {
      const result = await retrySyncIssue(ctx, {
        issueId: interaction.options.getString('issue_id'),
      });
      return interaction.editReply({
        embeds: [
          successEmbed(
            'Retry queued',
            `A fresh reconciliation was queued (job \`${result.job.id}\`). ` +
              'The retry re-plans against current state rather than replaying the old call.',
          ),
        ],
      });
    }

    default:
      throw new Error('Unknown subcommand');
  }
}

function auditEmbed(title, page) {
  if (page.items.length === 0) {
    return buildEmbed({ title, description: 'No audit records found.', color: 'neutral' });
  }

  const lines = page.items.map((entry) => {
    const when = `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:R>`;
    const actor = entry.actor?.displayName ?? entry.actorDiscordId ?? 'system';
    const target = entry.target?.displayName ? ` → ${entry.target.displayName}` : '';
    const status = entry.success ? '' : ' ❌';
    return `${when} \`${entry.action}\`${status}\n> by ${actor}${target}${
      entry.reason ? ` · ${truncate(entry.reason, 100)}` : ''
    }`;
  });

  return buildEmbed({
    title,
    description: truncate(lines.join('\n\n'), 4000),
    footer: `Page ${page.pagination.page} of ${page.pagination.totalPages} · ${page.pagination.total} records`,
  });
}

function issuesEmbed(page) {
  if (page.items.length === 0) {
    return buildEmbed({
      title: 'No unresolved failures',
      description: 'Everything is synchronizing cleanly.',
      color: 'success',
    });
  }

  return buildEmbed({
    title: `Unresolved failures (${page.pagination.total})`,
    color: 'warning',
    fields: page.items.slice(0, 10).map((issue) => ({
      name: `${issue.severity} · ${issue.type}`,
      value: truncate(
        [
          issue.message,
          issue.user ? `Member: ${issue.user.displayName}` : null,
          issue.guild ? `Server: ${issue.guild.name}` : null,
          issue.mapping ? `Mapping: ${issue.mapping.name}` : null,
          `Retries: ${issue.retryCount} · ID: \`${issue.id}\``,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    })),
    footer: `Retry one with /audit retry issue_id:<id> · ${orDash(page.pagination.totalPages)} page(s)`,
  });
}
