/**
 * Shared machinery for `/requesttraining` and `/requestinterview`.
 *
 * A request is an embed posted into the guild's designated request channel, with a thread
 * opened off it named for the applicant. The guild's FTO / instructor / staff roles are pinged
 * INSIDE the thread on open — that is what adds every holder of those roles to the thread —
 * and the thread auto-archives after a week.
 *
 * Runs in every guild: the main guild for the staff team, each department guild for its own
 * training program. Config is per guild (channel + ping roles), and the command refuses to run
 * anywhere but that guild's channel. Anyone who can see the channel may file (the channel's
 * own visibility is the gate, exactly like SSRP), so it runs without a linked bot actor.
 */
import { MessageFlags, ThreadAutoArchiveDuration } from 'discord.js';
import { getEnv } from '@frm/shared';
import { getRequestSettings } from '@frm/core';
import { createLogger, serializeError } from '@frm/logging';
import { COLORS, errorEmbed, successEmbed, truncate } from './ui.js';

const log = createLogger('bot.requestThreads');

export const KINDS = {
  training: {
    title: 'Training Request',
    noun: 'training',
    article: 'a training',
    threadPrefix: 'Training',
    channelsVar: 'TRAINING_REQUEST_CHANNELS',
    rolesVar: 'TRAINING_PING_ROLES',
  },
  interview: {
    title: 'Interview Request',
    noun: 'interview',
    article: 'an interview',
    threadPrefix: 'Interview',
    channelsVar: 'INTERVIEW_REQUEST_CHANNELS',
    rolesVar: 'INTERVIEW_PING_ROLES',
  },
};

/** Timezone choices offered on the command (Discord allows up to 25). */
export const TIMEZONES = [
  'EST', 'CST', 'MST', 'PST', 'AKST', 'HST', 'AST', 'GMT/UTC', 'BST', 'CET', 'IST', 'AEST',
];

/**
 * The guild's channel + ping roles for a request kind.
 *
 * The database row (set by Ownership with `/requestconfig`) wins; the per-guild env maps are
 * the fallback for a guild with no row. A database hiccup degrades to the env maps too, so a
 * request never fails just because the settings lookup did.
 */
export async function guildConfig(env, kind, guildId) {
  const k = KINDS[kind];
  try {
    const saved = await getRequestSettings(guildId, kind);
    if (saved) return { channelId: saved.channelId, roleIds: saved.pingRoleIds, source: 'db' };
  } catch (error) {
    log.warn({ err: serializeError(error), guildId, kind }, 'request settings lookup failed; using env');
  }
  return {
    channelId: env[k.channelsVar]?.[guildId] ?? null,
    roleIds: env[k.rolesVar]?.[guildId] ?? [],
    source: 'env',
  };
}

async function displayNameOf(interaction, user) {
  return interaction.guild?.members
    .fetch(user.id)
    .then((member) => member.displayName)
    .catch(() => user.globalName ?? user.username);
}

/**
 * The whole flow for one request: validate the guild/channel, post the embed, open the
 * thread, ping the roles inside it, confirm to the caller.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {'training'|'interview'} kind
 */
export async function runRequest(interaction, kind) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const env = getEnv();
  const k = KINDS[kind];
  const { channelId, roleIds } = await guildConfig(env, kind, interaction.guildId);

  if (!channelId) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          `${k.title}s are not set up here`,
          `This server has no ${k.noun} request channel configured yet. Ownership sets it with \`/requestconfig set\`.`,
        ),
      ],
    });
  }
  if (interaction.channelId !== channelId) {
    return interaction.editReply({
      embeds: [errorEmbed('Wrong channel', `Run this in <#${channelId}>.`)],
    });
  }

  const requester = interaction.user;
  const applicant = interaction.options.getUser('applicant') ?? requester;
  const dates = interaction.options.getString('dates');
  const times = interaction.options.getString('times');
  const timezone = interaction.options.getString('timezone');

  const applicantName = await displayNameOf(interaction, applicant);
  const requesterName = await displayNameOf(interaction, requester);
  const onBehalf = applicant.id !== requester.id;

  const embed = {
    title: k.title,
    description: onBehalf
      ? `**${requesterName}** has requested ${k.article} on behalf of **${applicantName}**. Availability below.`
      : `**${applicantName}** has requested ${k.article}. Availability below.`,
    color: COLORS.info,
    thumbnail: interaction.guild?.iconURL() ? { url: interaction.guild.iconURL() } : undefined,
    fields: [
      { name: 'Available Dates', value: truncate(dates, 1024) },
      { name: 'Available Times', value: truncate(times, 1024) },
      { name: 'Timezone', value: timezone },
    ],
    footer: { text: interaction.guild?.name ?? 'Florida Roleplay' },
    timestamp: new Date().toISOString(),
  };

  let channel;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch (error) {
    log.warn({ err: serializeError(error), channelId }, 'request channel fetch failed');
  }
  if (!channel?.isTextBased?.()) {
    return interaction.editReply({
      embeds: [errorEmbed('Channel unavailable', "I can't see the request channel — an admin should check my channel access.")],
    });
  }

  let thread;
  try {
    const message = await channel.send({ embeds: [embed] });
    thread = await message.startThread({
      name: truncate(`${k.threadPrefix} - ${applicantName}`, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `${k.title} filed by ${requester.tag}`,
    });

    // Pinging the roles INSIDE the thread is what adds their members to it. The applicant
    // and requester are mentioned too so they are in it as well.
    const users = [...new Set([applicant.id, requester.id])];
    const mentions = [...roleIds.map((id) => `<@&${id}>`), ...users.map((id) => `<@${id}>`)].join(' ');
    await thread.send({
      content: `${mentions} — ${k.noun} request for **${applicantName}**. Coordinate a time here.`,
      allowedMentions: { roles: roleIds, users },
    });
  } catch (error) {
    log.warn({ err: serializeError(error), channelId }, 'request thread creation failed');
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not open the thread',
          "The request was not posted. An admin should check that I can send messages and create public threads in that channel.",
        ),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(`${k.title} opened`, `Thread: <#${thread.id}>`, [
        { name: onBehalf ? 'On behalf of' : 'For', value: `<@${applicant.id}>`, inline: true },
        { name: 'Timezone', value: timezone, inline: true },
        {
          name: 'Who was added',
          value: roleIds.length
            ? `${roleIds.map((id) => `<@&${id}>`).join(', ')} were pinged in the thread.`
            : 'No roles are configured to ping for this server yet.',
        },
      ]),
    ],
  });
}

/** The option set both commands share. */
export function addRequestOptions(builder, kind) {
  const k = KINDS[kind];
  return builder
    .addStringOption((option) =>
      option.setName('dates').setDescription('Available dates, e.g. 06/20, 06/21').setRequired(true).setMaxLength(200),
    )
    .addStringOption((option) =>
      option.setName('times').setDescription('Available times, e.g. 12am, 6-9pm').setRequired(true).setMaxLength(200),
    )
    .addStringOption((option) =>
      option
        .setName('timezone')
        .setDescription('Your timezone')
        .setRequired(true)
        .addChoices(...TIMEZONES.map((tz) => ({ name: tz, value: tz }))),
    )
    .addUserOption((option) =>
      option
        .setName('applicant')
        .setDescription(`Who the ${k.noun} is for — leave blank if it's for you`)
        .setRequired(false),
    );
}
