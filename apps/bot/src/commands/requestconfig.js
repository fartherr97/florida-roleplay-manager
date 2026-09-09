/**
 * `/requestconfig` — Ownership sets up the training / interview request commands per guild.
 *
 *   /requestconfig set   <kind> <channel> <role1> [role2] [role3]
 *   /requestconfig show
 *   /requestconfig clear <kind>
 *
 * Run it inside the guild being configured. `set` stores which channel `/requesttraining` or
 * `/requestinterview` posts in and which roles are pinged inside the thread they open (their
 * members get added). No restart, no `.env`: the request commands read this on every use.
 * Ownership (REQUEST_CONFIG_ROLE_IDS, default the Owner + Co-Owner roles), FLRP global admins,
 * the guild owner, or Administrator-permission members; authorized by
 * the command itself, so it runs without a linked bot actor.
 */
import { ChannelType, MessageFlags, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getEnv } from '@frm/shared';
import { clearRequestSettings, listRequestSettings, setRequestSettings } from '@frm/core';
import { createLogger, serializeError } from '@frm/logging';
import { buildEmbed, errorEmbed, successEmbed } from '../lib/ui.js';
import { memberRoleIds } from '../lib/mikeTodo.js';
import { KINDS } from '../lib/requestThreads.js';

const log = createLogger('bot.requestconfig');

// Authorized by the command itself (Ownership roles), not by the bot's actor model.
export const actorExempt = true;

/** Ownership seats allowed to configure requests. Override with REQUEST_CONFIG_ROLE_IDS. */
const DEFAULT_OWNERSHIP_ROLE_IDS = [
  '1534380747689824276', // Owner
  '1534911243142303744', // Co-Owner
];

/**
 * Who may run /requestconfig in a given guild. The Ownership role ids only exist in the
 * main guild, so department guilds also accept: FLRP global admins (by user id), the
 * guild's own owner, and anyone holding the Administrator permission there.
 */
function canConfigure(interaction, env) {
  const userId = interaction.user.id;
  if (env.GLOBAL_ADMIN_DISCORD_IDS?.includes(userId)) return true;
  if (interaction.guild?.ownerId === userId) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const allowed = env.REQUEST_CONFIG_ROLE_IDS?.length ? env.REQUEST_CONFIG_ROLE_IDS : DEFAULT_OWNERSHIP_ROLE_IDS;
  const held = new Set(memberRoleIds(interaction));
  return allowed.some((id) => held.has(id));
}

const kindOption = (option) =>
  option
    .setName('kind')
    .setDescription('Which request command this is for')
    .setRequired(true)
    .addChoices({ name: 'Training', value: 'training' }, { name: 'Interview', value: 'interview' });

export const data = new SlashCommandBuilder()
  .setName('requestconfig')
  .setDescription('Ownership: configure /requesttraining and /requestinterview for this server')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set the request channel and the roles pinged in the thread')
      .addStringOption(kindOption)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('The channel the command may be run in and posts to')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText),
      )
      .addRoleOption((option) =>
        option.setName('role1').setDescription('Role pinged in the thread (e.g. FTO)').setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName('role2').setDescription('Another role to ping (e.g. Academy Instructor)').setRequired(false),
      )
      .addRoleOption((option) =>
        option.setName('role3').setDescription('Another role to ping').setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('show').setDescription("Show this server's request configuration"))
  .addSubcommand((sub) =>
    sub.setName('clear').setDescription('Remove the configuration for a request kind').addStringOption(kindOption),
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const env = getEnv();

  if (!canConfigure(interaction, env)) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Not allowed here',
          'Only FLRP Ownership, this server\'s owner, or a member with the Administrator permission can configure the request commands.',
        ),
      ],
    });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  try {
    if (sub === 'set') {
      const kind = interaction.options.getString('kind');
      const channel = interaction.options.getChannel('channel');
      const roles = ['role1', 'role2', 'role3']
        .map((name) => interaction.options.getRole(name))
        .filter(Boolean);
      const saved = await setRequestSettings({
        discordGuildId: guildId,
        kind,
        channelId: channel.id,
        pingRoleIds: roles.map((role) => role.id),
        updatedBy: interaction.user.id,
      });
      return interaction.editReply({
        embeds: [
          successEmbed(`${KINDS[kind].title}s configured`, `Saved for **${interaction.guild?.name ?? 'this server'}**.`, [
            { name: 'Command', value: `\`/request${kind}\``, inline: true },
            { name: 'Channel', value: `<#${saved.channelId}>`, inline: true },
            { name: 'Pinged in thread', value: saved.pingRoleIds.map((id) => `<@&${id}>`).join(', ') || '—' },
          ]),
        ],
      });
    }

    if (sub === 'clear') {
      const kind = interaction.options.getString('kind');
      const removed = await clearRequestSettings(guildId, kind);
      return interaction.editReply({
        embeds: [
          removed
            ? successEmbed(`${KINDS[kind].title}s cleared`, `\`/request${kind}\` now falls back to the env config for this server, if any.`)
            : errorEmbed('Nothing to clear', `\`/request${kind}\` had no saved configuration here.`),
        ],
      });
    }

    // show
    const rows = await listRequestSettings(guildId);
    const fields = ['training', 'interview'].map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      const envChannel = env[KINDS[kind].channelsVar]?.[guildId];
      const envRoles = env[KINDS[kind].rolesVar]?.[guildId] ?? [];
      let value;
      if (row) {
        value = `Channel: <#${row.channelId}>\nPings: ${row.pingRoleIds.map((id) => `<@&${id}>`).join(', ') || '—'}\n*(saved with /requestconfig)*`;
      } else if (envChannel) {
        value = `Channel: <#${envChannel}>\nPings: ${envRoles.map((id) => `<@&${id}>`).join(', ') || '—'}\n*(from env — not yet saved here)*`;
      } else {
        value = 'Not configured — run `/requestconfig set`.';
      }
      return { name: `/request${kind}`, value };
    });
    return interaction.editReply({
      embeds: [buildEmbed({ title: `Request configuration — ${interaction.guild?.name ?? 'this server'}`, fields, color: 'info' })],
    });
  } catch (error) {
    log.warn({ err: serializeError(error), sub, guildId }, 'requestconfig failed');
    return interaction.editReply({ embeds: [errorEmbed('Could not save that', explainDbError(error))] });
  }
}

/**
 * Turns a database failure into the message an operator needs. A missing table or an
 * out-of-date client is a deploy problem, not a transient one — say so, rather than "try
 * again" for something that will never succeed on its own.
 */
function explainDbError(error) {
  const code = error?.code;
  const message = String(error?.message ?? '');
  if (code === 'P2021' || code === 'P2022' || /does not exist/i.test(message)) {
    return (
      'The database is missing the request-settings table — the latest migration has not been ' +
      'applied. On the bot host run `npx prisma migrate deploy`, then restart the bot.'
    );
  }
  if (error instanceof TypeError && /undefined/.test(message)) {
    return (
      "The bot's database client is out of date (it has no request-settings model). On the bot " +
      'host run `npx prisma generate`, then restart the bot.'
    );
  }
  return 'The database did not answer. Try again in a moment.';
}
