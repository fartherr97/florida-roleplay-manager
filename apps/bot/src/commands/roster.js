/**
 * `/roster` - the staff rosters published on the community website.
 *
 * A roster is configured once (create it, bind a Discord role to each rank) and then
 * runs itself: holding a bound role puts somebody on the roster at that rank and rewrites
 * their nickname to `Callsign | Rank | Name`; losing every bound role takes them off it
 * again. Nothing here adds a member by hand, because that would be a second source of
 * truth - the Discord roles are the roster.
 *
 * What this command exists for is the two things the platform cannot work out on its
 * own: the configuration, and a member's callsign and name.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  bindRosterRank,
  createRoster,
  getRoster,
  listRosters,
  setRosterMemberDetails,
  syncRoster,
  unbindRosterRank,
  updateRoster,
} from '@frm/core';
import { buildEmbed, renderError, successEmbed, truncate } from '../lib/ui.js';
import { dryRunOption, memberOption, reasonOption } from '../lib/options.js';

const slugOption =
  (description = 'The roster, by its website slug (e.g. "staff")') =>
  (option) =>
    option.setName('roster').setDescription(description).setRequired(true).setMaxLength(48);

export const data = new SlashCommandBuilder()
  .setName('roster')
  .setDescription('Staff rosters published on the website')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a roster for this server')
      .addStringOption(slugOption('URL slug the website uses, e.g. "staff" or "hcso"'))
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Display name, e.g. "Staff Team"')
          .setRequired(true)
          .setMaxLength(80),
      )
      .addStringOption((option) =>
        option.setName('description').setDescription('Shown under the heading').setMaxLength(500),
      )
      .addIntegerOption((option) =>
        option
          .setName('position')
          .setDescription('Ordering on the website (lower comes first)')
          .setMinValue(0)
          .setMaxValue(999),
      )
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rank')
      .setDescription('Bind a Discord role to a rank on a roster')
      .addStringOption(slugOption())
      .addRoleOption((option) =>
        option
          .setName('role')
          .setDescription('Holding this role is being this rank')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Rank name, e.g. "Senior Administrator"')
          .setRequired(true)
          .setMaxLength(60),
      )
      .addIntegerOption((option) =>
        option
          .setName('seniority')
          .setDescription('Higher outranks lower, and wins when somebody holds several ranks')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(999),
      )
      .addStringOption((option) =>
        option
          .setName('short_name')
          .setDescription('Abbreviation used in nicknames, e.g. "Sr. Admin"')
          .setMaxLength(20),
      )
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unrank')
      .setDescription('Unbind a role from a rank (its holders stay on the roster, unranked)')
      .addStringOption(slugOption())
      .addRoleOption((option) =>
        option.setName('role').setDescription('The bound role').setRequired(true),
      )
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('member')
      .setDescription("Set a roster member's callsign and displayed name")
      .addStringOption(slugOption())
      .addUserOption(memberOption(true))
      .addStringOption((option) =>
        option
          .setName('callsign')
          .setDescription('e.g. "165". Use "none" to clear')
          .setMaxLength(10),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('The name they are shown under. Use "none" to fall back to their own')
          .setMaxLength(32),
      )
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('sync')
      .setDescription('Reconcile a roster against Discord now')
      .addStringOption(slugOption())
      .addUserOption(memberOption(false, 'member', 'Only this member, instead of everybody'))
      .addBooleanOption(dryRunOption)
      .addStringOption(reasonOption(false)),
  )
  .addSubcommand((sub) =>
    sub.setName('view').setDescription('Show a roster').addStringOption(slugOption()),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show every roster'))
  .addSubcommand((sub) =>
    sub
      .setName('publish')
      .setDescription('Show or hide a roster on the website')
      .addStringOption(slugOption())
      .addBooleanOption((option) =>
        option
          .setName('published')
          .setDescription('Whether the website serves this roster')
          .setRequired(true),
      )
      .addStringOption(reasonOption(false)),
  );

export async function execute(interaction, { ctx }) {
  switch (interaction.options.getSubcommand()) {
    case 'create':
      return handleCreate(interaction, ctx);
    case 'rank':
      return handleRank(interaction, ctx);
    case 'unrank':
      return handleUnrank(interaction, ctx);
    case 'member':
      return handleMember(interaction, ctx);
    case 'sync':
      return handleSync(interaction, ctx);
    case 'view':
      return handleView(interaction, ctx);
    case 'list':
      return handleList(interaction, ctx);
    case 'publish':
      return handlePublish(interaction, ctx);
    default:
      throw new Error('Unknown subcommand');
  }
}

/**
 * "none" is how a slash command says "clear this": Discord has no way to send an
 * explicit null, and an empty string is rejected by the option validator.
 */
function nullableOption(interaction, name) {
  const value = interaction.options.getString(name);
  if (value === null) return undefined;
  return value.trim().toLowerCase() === 'none' ? null : value;
}

async function handleCreate(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let roster;
  try {
    roster = await createRoster(ctx, {
      slug: interaction.options.getString('roster'),
      name: interaction.options.getString('name'),
      description: interaction.options.getString('description') ?? undefined,
      discordGuildId: interaction.guildId,
      position: interaction.options.getInteger('position') ?? undefined,
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Roster created',
        `**${roster.name}** is ready. Bind a Discord role to each rank with \`/roster rank\` - ` +
          'until at least one role is bound the roster stays empty, because nothing tells it ' +
          'who belongs on it.',
        [
          { name: 'Slug', value: `\`${roster.slug}\``, inline: true },
          { name: 'Published', value: roster.published ? 'Yes' : 'No', inline: true },
        ],
      ),
    ],
  });
}

async function handleRank(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('role');
  const slug = interaction.options.getString('roster');

  let rank;
  try {
    rank = await bindRosterRank(ctx, {
      slug,
      discordRoleId: role.id,
      name: interaction.options.getString('name'),
      shortName: interaction.options.getString('short_name') ?? undefined,
      position: interaction.options.getInteger('seniority'),
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  const short = rank.shortName ?? rank.name;
  return interaction.editReply({
    embeds: [
      successEmbed(
        'Rank bound',
        `Anyone holding <@&${role.id}> is now **${rank.name}** on \`${slug}\`, and their ` +
          `nickname will read \`165 | ${short} | Name\`.`,
        [
          { name: 'Seniority', value: String(rank.position), inline: true },
          { name: 'In nicknames', value: short, inline: true },
        ],
      ),
    ],
    content: 'Run `/roster sync` when you have bound every rank, to bring existing members in.',
  });
}

async function handleUnrank(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const role = interaction.options.getRole('role');

  let result;
  try {
    result = await unbindRosterRank(ctx, {
      slug: interaction.options.getString('roster'),
      discordRoleId: role.id,
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  return interaction.editReply({
    embeds: [
      result.removed
        ? successEmbed(
            'Rank unbound',
            `<@&${role.id}> no longer confers **${result.rank}**. Anybody who held it stays on ` +
              'the roster without a rank until the next sync places them.',
          )
        : buildEmbed({
            title: 'Nothing to unbind',
            description: `<@&${role.id}> was not bound to a rank on that roster.`,
            color: 'neutral',
          }),
    ],
  });
}

async function handleMember(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const callsign = nullableOption(interaction, 'callsign');
  const preferredName = nullableOption(interaction, 'name');

  let result;
  try {
    result = await setRosterMemberDetails(ctx, {
      slug: interaction.options.getString('roster'),
      discordUserId: user.id,
      callsign,
      preferredName,
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        'Roster member updated',
        `<@${user.id}> updated. Their nickname is being rewritten now.`,
        [
          { name: 'Callsign', value: result.membership.callsign ?? '—', inline: true },
          { name: 'Name', value: result.membership.preferredName ?? '—', inline: true },
        ],
      ),
    ],
  });
}

async function handleSync(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const dryRun = interaction.options.getBoolean('dry_run') ?? false;

  let result;
  try {
    result = await syncRoster(ctx, {
      slug: interaction.options.getString('roster'),
      discordUserId: user?.id ?? undefined,
      dryRun,
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        dryRun ? 'Preview queued' : 'Synchronization queued',
        dryRun
          ? 'The changes will be worked out and recorded without being applied. Check ' +
              '`/audit failures` and the job log for what it would have done.'
          : `${user ? `<@${user.id}> is` : 'Everyone on the roster is'} being reconciled ` +
              'against Discord now.',
        [{ name: 'Job', value: `\`${result.jobId ?? 'not queued'}\`` }],
      ),
    ],
  });
}

async function handleView(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let roster;
  try {
    roster = await getRoster(ctx, interaction.options.getString('roster'));
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  const populated = roster.ranks.filter((rank) => rank.members.length > 0);
  if (populated.length === 0) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: roster.name,
          description:
            'Nobody is on this roster yet. Bind a Discord role to a rank with `/roster rank`, ' +
            'then run `/roster sync`.',
          color: 'neutral',
        }),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: roster.name,
        description: roster.description ?? null,
        color: 'info',
        fields: populated.slice(0, 25).map((rank) => ({
          name: `${rank.name} (${rank.members.length})`,
          value: truncate(
            rank.members
              .map(
                (member) =>
                  `${member.callsign ? `\`${member.callsign}\` ` : ''}<@${member.discordUserId}>`,
              )
              .join('\n'),
            1024,
          ),
        })),
        footer: 'Ranks come from Discord roles. Change the role, and this changes with it.',
      }),
    ],
  });
}

async function handleList(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let rosters;
  try {
    rosters = await listRosters(ctx, { includeUnpublished: true });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  if (rosters.length === 0) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'No rosters yet',
          description: 'Create one with `/roster create`.',
          color: 'neutral',
        }),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: 'Rosters',
        color: 'info',
        description: truncate(
          rosters
            .map((roster) => {
              const members = roster.ranks.reduce((sum, rank) => sum + rank.members.length, 0);
              return `\`${roster.slug}\` — **${roster.name}** · ${roster.ranks.length} ranks · ${members} members`;
            })
            .join('\n'),
          4000,
        ),
      }),
    ],
  });
}

async function handlePublish(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const published = interaction.options.getBoolean('published');

  let roster;
  try {
    roster = await updateRoster(ctx, {
      slug: interaction.options.getString('roster'),
      published,
      reason: interaction.options.getString('reason') ?? undefined,
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)] });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        published ? 'Roster published' : 'Roster hidden',
        published
          ? `**${roster.name}** is now served to the website.`
          : `**${roster.name}** is no longer served to the website. It carries on being kept ` +
              'in step with Discord, so publishing it again shows current information.',
      ),
    ],
  });
}
