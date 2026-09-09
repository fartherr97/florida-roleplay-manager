/**
 * `/request` — file a staff request for the Support Team to action.
 *
 *   /request ban  <member> <duration> <reason> [evidence]   a ban request, with timeframe
 *   /request da   <member> <reason> [evidence]              a Disciplinary Action request
 *                                                           on a whitelisted member
 *
 * Each subcommand posts an embed into the staff request channel (REQUEST_CHANNEL_ID) with the
 * Support Team role (REQUEST_PING_ROLE_ID) pinged above it, and records who filed it. Staff
 * (REQUEST_ALLOWED_ROLE_IDS, default the Server Staff Team) may file; the command authorizes
 * its caller itself, so it runs without a linked bot actor — allowlist + rate limit still apply.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { formatDuration, getEnv, parseDuration } from '@frm/shared';
import { COLORS, errorEmbed, successEmbed, truncate } from '../lib/ui.js';
import { memberOption, reasonOption } from '../lib/options.js';
import { displayNameOf, mayFileRequest, postRequest } from '../lib/staffRequests.js';

// Authorized by the command itself (staff roles), not by the bot's actor model.
export const actorExempt = true;

const evidenceOption = (option) =>
  option
    .setName('evidence')
    .setDescription('Clip / screenshot link or ticket reference (optional)')
    .setRequired(false)
    .setMaxLength(500);

export const data = new SlashCommandBuilder()
  .setName('request')
  .setDescription('File a request for the Support Team')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('ban')
      .setDescription('Request a ban on a member')
      .addUserOption(memberOption(true, 'member', 'The member the ban is for'))
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('Timeframe, e.g. 3d, 12h, 1w, 1d12h — or "permanent"')
          .setRequired(true)
          .setMaxLength(32),
      )
      .addStringOption(reasonOption(true, 'Why the ban is being requested'))
      .addStringOption(evidenceOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('da')
      .setDescription('Request a Disciplinary Action on a whitelisted member')
      .addUserOption(memberOption(true, 'member', 'The whitelisted member the DA is for'))
      .addStringOption(reasonOption(true, 'What happened and why a DA is warranted'))
      .addStringOption(evidenceOption),
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const env = getEnv();

  if (!mayFileRequest(interaction, env.REQUEST_ALLOWED_ROLE_IDS)) {
    return interaction.editReply({
      embeds: [errorEmbed('Staff only', 'Only staff can file Support Team requests.')],
    });
  }
  if (!env.REQUEST_CHANNEL_ID) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Requests unavailable',
          'The request channel is not configured yet. Set `REQUEST_CHANNEL_ID` to the staff request channel.',
        ),
      ],
    });
  }

  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getUser('member');
  const reason = interaction.options.getString('reason');
  const evidence = interaction.options.getString('evidence');
  const name = await displayNameOf(interaction, target);

  const fields = [
    { name: 'Member', value: `<@${target.id}>\n\`${target.id}\``, inline: true },
    { name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true },
  ];
  let title;
  let color;

  if (sub === 'ban') {
    // Throws a friendly validation error on a typo, which the interaction handler renders.
    const durationMs = parseDuration(interaction.options.getString('duration'));
    const timeframe = durationMs ? formatDuration(durationMs) : 'Permanent';
    title = `🔨 Ban Request — ${name}`;
    color = COLORS.danger;
    fields.push({ name: 'Requested timeframe', value: timeframe, inline: true });
  } else {
    title = `📋 Disciplinary Action Request — ${name}`;
    color = COLORS.warning;
  }

  fields.push({ name: 'Reason', value: truncate(reason, 1024), inline: false });
  if (evidence) fields.push({ name: 'Evidence', value: truncate(evidence, 1024), inline: false });

  const embed = {
    title: truncate(title, 256),
    color,
    fields,
    footer: { text: sub === 'ban' ? 'Ban request · awaiting Support Team' : 'DA request · awaiting Support Team' },
    timestamp: new Date().toISOString(),
  };

  const result = await postRequest(interaction, {
    channelId: env.REQUEST_CHANNEL_ID,
    pingRoleId: env.REQUEST_PING_ROLE_ID || undefined,
    embed,
  });

  if (!result.ok) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not post the request',
          result.reason === 'channel_unavailable'
            ? "I can't see the request channel — an admin should check `REQUEST_CHANNEL_ID` and my channel access."
            : 'The request channel did not accept it. Try again in a moment.',
        ),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        sub === 'ban' ? 'Ban request filed' : 'DA request filed',
        `Posted in <#${env.REQUEST_CHANNEL_ID}> for <@${target.id}>.`,
        [
          {
            name: 'Support Team',
            value: result.pinged
              ? 'Pinged — they will pick it up from the request channel.'
              : 'Posted without a ping (`REQUEST_PING_ROLE_ID` is not set).',
          },
        ],
      ),
    ],
  });
}
