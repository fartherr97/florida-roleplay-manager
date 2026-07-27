/**
 * `/roster` - department roster actions.
 *
 * Each subcommand is a direct translation into a `@frm/core` call. Permission checks,
 * rank hierarchy rules, transactions, audit records and synchronization all happen
 * there, so the same rules apply identically from the website.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  changeCallsign,
  demoteMember,
  hireMember,
  listRoster,
  placeOnLeave,
  promoteMember,
  reinstateMember,
  removeMember,
  returnFromLeave,
  suspendMember,
  transferMember,
} from '@frm/core';
import { MembershipStatus } from '@frm/shared';
import { buildEmbed, orDash, requestConfirmation, successEmbed } from '../lib/ui.js';
import { departmentOption, memberOption, rankOption, reasonOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('roster')
  .setDescription('Department roster management')
  .addSubcommand((sub) =>
    sub
      .setName('hire')
      .setDescription('Hire a member into a department')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(rankOption(true))
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option.setName('callsign').setDescription('Callsign, e.g. H-101').setRequired(false),
      )
      .addStringOption((option) =>
        option.setName('badge').setDescription('Badge number').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('promote')
      .setDescription('Promote a member')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(rankOption(true, 'rank', 'The rank to promote to'))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('demote')
      .setDescription('Demote a member')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(rankOption(true, 'rank', 'The rank to demote to'))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('transfer')
      .setDescription('Transfer a member to another department')
      .addStringOption(departmentOption(true, 'department', 'Current department'))
      .addUserOption(memberOption(true))
      .addStringOption(departmentOption(true, 'target_department', 'Destination department'))
      .addStringOption(rankOption(true, 'target_rank', 'Rank in the destination department'))
      .addStringOption(reasonOption(true))
      .addBooleanOption((option) =>
        option
          .setName('keep_callsign')
          .setDescription('Keep the current callsign')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('loa')
      .setDescription('Place a member on leave of absence')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option.setName('until').setDescription('Return date (YYYY-MM-DD)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('return')
      .setDescription('Return a member from leave')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('suspend')
      .setDescription('Suspend a member')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option.setName('until').setDescription('End date (YYYY-MM-DD)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reinstate')
      .setDescription('Reinstate a suspended member')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a member from a department roster')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('callsign')
      .setDescription('Change a member callsign')
      .addStringOption(departmentOption(true))
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option.setName('callsign').setDescription('The new callsign').setRequired(true),
      )
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Show a department roster')
      .addStringOption(departmentOption(true))
      .addStringOption((option) =>
        option
          .setName('status')
          .setDescription('Filter by membership status')
          .addChoices(...Object.values(MembershipStatus).map((value) => ({ name: value, value })))
          .setRequired(false),
      ),
  );

export async function execute(interaction, { ctx }) {
  const sub = interaction.options.getSubcommand();
  const common = () => ({
    departmentId: interaction.options.getString('department'),
    discordUserId: interaction.options.getUser('member')?.id,
    reason: interaction.options.getString('reason'),
  });

  switch (sub) {
    case 'hire':
      return runAction(interaction, () =>
        hireMember(ctx, {
          ...common(),
          rankId: interaction.options.getString('rank'),
          callsign: interaction.options.getString('callsign') ?? undefined,
          badgeNumber: interaction.options.getString('badge') ?? undefined,
        }),
      );

    case 'promote':
      return runAction(interaction, () =>
        promoteMember(ctx, { ...common(), rankId: interaction.options.getString('rank') }),
      );

    case 'demote':
      return runAction(interaction, () =>
        demoteMember(ctx, { ...common(), rankId: interaction.options.getString('rank') }),
      );

    case 'transfer':
      return runAction(interaction, () =>
        transferMember(ctx, {
          ...common(),
          targetDepartmentId: interaction.options.getString('target_department'),
          targetRankId: interaction.options.getString('target_rank'),
          keepCallsign: interaction.options.getBoolean('keep_callsign') ?? false,
        }),
      );

    case 'loa':
      return runAction(interaction, () =>
        placeOnLeave(ctx, {
          ...common(),
          until: interaction.options.getString('until') ?? undefined,
        }),
      );

    case 'return':
      return runAction(interaction, () => returnFromLeave(ctx, common()));

    case 'suspend':
      return runAction(interaction, () =>
        suspendMember(ctx, {
          ...common(),
          until: interaction.options.getString('until') ?? undefined,
        }),
      );

    case 'reinstate':
      return runAction(interaction, () => reinstateMember(ctx, common()));

    case 'callsign':
      return runAction(interaction, () =>
        changeCallsign(ctx, { ...common(), callsign: interaction.options.getString('callsign') }),
      );

    case 'remove':
      return handleRemove(interaction, ctx, common());

    case 'list':
      return handleList(interaction, ctx);

    default:
      throw new Error('Unknown subcommand');
  }
}

/** Runs a roster mutation and renders the resulting membership. */
async function runAction(interaction, action) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await action();
  return interaction.editReply({ embeds: [membershipEmbed(result)] });
}

/** Termination is destructive, so it is confirmed first. */
async function handleRemove(interaction, ctx, input) {
  const user = interaction.options.getUser('member');

  const confirmed = await requestConfirmation(interaction, {
    title: `Remove ${user.tag} from the roster?`,
    description:
      'Their membership is marked terminated, their callsign is released and every department ' +
      'role is removed in Discord. The history is kept.',
    confirmLabel: 'Remove member',
  });
  if (!confirmed) return undefined;

  const result = await removeMember(ctx, input);
  return interaction.editReply({ embeds: [membershipEmbed(result)], components: [] });
}

async function handleList(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const status = interaction.options.getString('status');
  const page = await listRoster(ctx, {
    departmentId: interaction.options.getString('department'),
    ...(status ? { status } : {}),
    pageSize: 25,
  });

  if (page.items.length === 0) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'No members found', color: 'neutral' })],
    });
  }

  const lines = page.items.map(
    (membership) =>
      `\`${orDash(membership.callsign).padEnd(8)}\` **${membership.rank.name}** — ${membership.user.displayName}` +
      `${membership.status === MembershipStatus.ACTIVE ? '' : ` _(${membership.status})_`}`,
  );

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: `${page.items[0].department.abbreviation} roster (${page.pagination.total})`,
        description: lines.join('\n'),
        footer: `Page ${page.pagination.page} of ${page.pagination.totalPages}`,
      }),
    ],
  });
}

function membershipEmbed({ membership, syncJob, enqueued }) {
  return successEmbed(
    'Roster updated',
    `**${membership.user.displayName}** — ${membership.department.abbreviation}`,
    [
      { name: 'Rank', value: membership.rank.name, inline: true },
      { name: 'Status', value: membership.status, inline: true },
      { name: 'Callsign', value: orDash(membership.callsign), inline: true },
      {
        name: 'Synchronization',
        value:
          enqueued === false
            ? 'Queued in the database but the queue was unavailable. It will be repaired by scheduled reconciliation.'
            : `Queued (job \`${syncJob?.id ?? 'n/a'}\`)`,
      },
    ],
  );
}
