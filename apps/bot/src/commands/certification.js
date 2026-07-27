/**
 * `/certification` - certifications and subdivisions.
 *
 * Both are roster-authoritative, so assigning one queues a resync automatically.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  addToSubdivision,
  assignCertification,
  listCertifications,
  listMemberCertifications,
  lookupMember,
  removeCertification,
  removeFromSubdivision,
} from '@frm/core';
import { buildEmbed, orDash, successEmbed } from '../lib/ui.js';
import { departmentOption, memberOption, reasonOption } from '../lib/options.js';

export const data = new SlashCommandBuilder()
  .setName('certification')
  .setDescription('Certifications and subdivisions')
  .addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Assign a certification to a member')
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option
          .setName('certification')
          .setDescription('The certification')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption(reasonOption(true))
      .addStringOption((option) =>
        option.setName('expires').setDescription('Expiry date (YYYY-MM-DD)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a certification from a member')
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option
          .setName('certification')
          .setDescription('The certification')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List certifications')
      .addUserOption(memberOption(false, 'member', 'Show one member certifications instead'))
      .addStringOption(departmentOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('subdivision-add')
      .setDescription('Add a member to a subdivision')
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option
          .setName('subdivision')
          .setDescription('The subdivision')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption(reasonOption(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('subdivision-remove')
      .setDescription('Remove a member from a subdivision')
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option
          .setName('subdivision')
          .setDescription('The subdivision')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption(reasonOption(true)),
  );

export async function execute(interaction, { ctx }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();
  const user = interaction.options.getUser('member');
  const reason = interaction.options.getString('reason');

  switch (sub) {
    case 'assign': {
      const result = await assignCertification(ctx, {
        discordUserId: user.id,
        certificationId: interaction.options.getString('certification'),
        expiresAt: interaction.options.getString('expires') ?? undefined,
        reason,
      });
      return interaction.editReply({
        embeds: [
          successEmbed('Certification assigned', `<@${user.id}> has been certified.`, [
            {
              name: 'Expires',
              value: result.record.expiresAt
                ? `<t:${Math.floor(new Date(result.record.expiresAt).getTime() / 1000)}:D>`
                : 'never',
              inline: true,
            },
            { name: 'Synchronization', value: `Job \`${result.syncJob.id}\``, inline: true },
          ]),
        ],
      });
    }

    case 'remove': {
      const result = await removeCertification(ctx, {
        discordUserId: user.id,
        certificationId: interaction.options.getString('certification'),
        reason,
      });
      return interaction.editReply({
        embeds: [
          successEmbed('Certification removed', `<@${user.id}> no longer holds it.`, [
            { name: 'Synchronization', value: `Job \`${result.syncJob.id}\`` },
          ]),
        ],
      });
    }

    case 'subdivision-add': {
      const result = await addToSubdivision(ctx, {
        discordUserId: user.id,
        subdivisionId: interaction.options.getString('subdivision'),
        reason,
      });
      return interaction.editReply({
        embeds: [
          successEmbed('Subdivision updated', `<@${user.id}> has been added.`, [
            { name: 'Synchronization', value: `Job \`${result.syncJob.id}\`` },
          ]),
        ],
      });
    }

    case 'subdivision-remove': {
      const result = await removeFromSubdivision(ctx, {
        discordUserId: user.id,
        subdivisionId: interaction.options.getString('subdivision'),
        reason,
      });
      return interaction.editReply({
        embeds: [
          successEmbed('Subdivision updated', `<@${user.id}> has been removed.`, [
            { name: 'Synchronization', value: `Job \`${result.syncJob.id}\`` },
          ]),
        ],
      });
    }

    case 'list':
      return handleList(interaction, ctx, user);

    default:
      throw new Error('Unknown subcommand');
  }
}

async function handleList(interaction, ctx, user) {
  if (user) {
    const profile = await lookupMember(ctx, { discordUserId: user.id });
    const held = await listMemberCertifications(ctx, { userId: profile.user.id });

    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: `Certifications: ${profile.user.displayName}`,
          description:
            held
              .map(
                (entry) =>
                  `• **${entry.certification.name}** — issued <t:${Math.floor(new Date(entry.issuedAt).getTime() / 1000)}:d>` +
                  `${entry.expiresAt ? `, expires <t:${Math.floor(new Date(entry.expiresAt).getTime() / 1000)}:d>` : ''}`,
              )
              .join('\n') || 'None held.',
        }),
      ],
    });
  }

  const departmentId = interaction.options.getString('department');
  const certifications = await listCertifications(ctx, { departmentId: departmentId ?? undefined });

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: `Certifications (${certifications.length})`,
        description:
          certifications
            .map(
              (certification) =>
                `• **${certification.name}** \`${certification.key}\` — ${orDash(certification.department?.abbreviation)} · ${certification._count.members} holder(s)`,
            )
            .join('\n') || 'No certifications configured.',
      }),
    ],
  });
}
