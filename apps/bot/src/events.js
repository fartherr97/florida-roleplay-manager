/**
 * Discord event wiring.
 *
 * The handlers here do three things and no more: normalise the discord.js payload,
 * check the allowlist, and call into `@frm/core`. All of the decision logic - marker
 * consumption, relevance checks, job creation - lives in the event service, where it can
 * be tested without a gateway connection.
 */
import { AuditLogEvent, Events } from 'discord.js';
import { createLogger, serializeError } from '@frm/logging';
import {
  handleGuildRemoved,
  handleMemberJoin,
  handleMemberLeave,
  handleMemberNicknameChange,
  handleMemberRoleChange,
  handleRoleDeleted,
  handleRoleUpdated,
  handleUnapprovedGuildJoin,
  isGuildApproved,
} from '@frm/core';
import { handleInteraction } from './interactions.js';
import { registerGuildCommands } from './lib/register.js';

const log = createLogger('bot.events');

/**
 * @param {import('discord.js').Client} client
 * @param {{gateway: object, env: object}} deps
 */
export function registerEventHandlers(client, { gateway, env }) {
  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction, { gateway }).catch((error) => {
      log.error({ err: serializeError(error) }, 'unhandled interaction error');
    });
  });

  // --- guild lifecycle -----------------------------------------------------

  client.on(Events.GuildCreate, async (guild) => {
    try {
      const approved = await isGuildApproved(guild.id);
      let staying = approved;

      if (approved) {
        log.info({ discordGuildId: guild.id, name: guild.name }, 'joined an approved guild');
      } else {
        // Not on the allowlist: audit it, alert the administrators, and leave unless
        // auto-leave is switched off (for onboarding) or development mode is on.
        const result = await handleUnapprovedGuildJoin({
          discordGuildId: guild.id,
          name: guild.name,
          memberCount: guild.memberCount,
          gateway,
        });
        staying = !result.left;
        log.warn(
          { discordGuildId: guild.id, name: guild.name, left: result.left },
          'joined an unapproved guild',
        );
      }

      // If the bot is staying, make its commands available in this server immediately.
      // Guild-scoped registration is instant; without it a freshly onboarded server
      // (including one kept via auto-leave-off, where `/setup department` must be usable)
      // would show no commands until global propagation, up to an hour later. Only in
      // guild scope - registering guild commands while also registered globally would
      // show every command twice.
      if (staying && env.DEV_GUILD_IDS.length > 0) {
        try {
          await registerGuildCommands({ env, guildIds: [guild.id] });
          log.info({ discordGuildId: guild.id }, 'registered commands for newly joined guild');
        } catch (error) {
          log.error(
            { err: serializeError(error), discordGuildId: guild.id },
            'failed to register commands for newly joined guild',
          );
        }
      }
    } catch (error) {
      log.error({ err: serializeError(error), discordGuildId: guild.id }, 'guildCreate failed');
    }
  });

  client.on(Events.GuildDelete, async (guild) => {
    try {
      await handleGuildRemoved({ discordGuildId: guild.id, name: guild.name });
    } catch (error) {
      log.error({ err: serializeError(error), discordGuildId: guild.id }, 'guildDelete failed');
    }
  });

  // --- member lifecycle ----------------------------------------------------

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
      const before = new Set(oldMember.roles.cache.keys());
      const after = new Set(newMember.roles.cache.keys());

      const addedRoleIds = [...after].filter((id) => !before.has(id) && id !== newMember.guild.id);
      const removedRoleIds = [...before].filter(
        (id) => !after.has(id) && id !== newMember.guild.id,
      );

      // One event can carry both a role change and a rename, and they are handled
      // separately: a promotion is reconciled from roles, while a bare rename is drift
      // in a nickname the platform owns.
      if (oldMember.nickname !== newMember.nickname) {
        await handleMemberNicknameChange({
          discordGuildId: newMember.guild.id,
          discordUserId: newMember.id,
          nickname: newMember.nickname ?? null,
          gateway,
        }).catch((error) => {
          log.error({ err: serializeError(error) }, 'nickname change handling failed');
        });
      }

      if (addedRoleIds.length === 0 && removedRoleIds.length === 0) return;

      const executorDiscordId = await findRoleChangeExecutor(newMember);

      const result = await handleMemberRoleChange({
        discordGuildId: newMember.guild.id,
        discordUserId: newMember.id,
        addedRoleIds,
        removedRoleIds,
        executorDiscordId,
        // Needed to re-read live roles when an access-tier role changed hands.
        gateway,
      });

      log.debug(
        {
          discordGuildId: newMember.guild.id,
          discordUserId: newMember.id,
          added: addedRoleIds.length,
          removed: removedRoleIds.length,
          queued: result.queued,
          reason: result.reason,
        },
        'member role change processed',
      );
    } catch (error) {
      log.error({ err: serializeError(error) }, 'guildMemberUpdate failed');
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      await handleMemberJoin({ discordGuildId: member.guild.id, discordUserId: member.id });
    } catch (error) {
      log.error({ err: serializeError(error) }, 'guildMemberAdd failed');
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      await handleMemberLeave({ discordGuildId: member.guild.id, discordUserId: member.id });
    } catch (error) {
      log.error({ err: serializeError(error) }, 'guildMemberRemove failed');
    }
  });

  // --- role lifecycle ------------------------------------------------------

  client.on(Events.GuildRoleDelete, async (role) => {
    try {
      const result = await handleRoleDeleted({
        discordGuildId: role.guild.id,
        discordRoleId: role.id,
        roleName: role.name,
      });
      if (result.affected > 0) {
        log.warn(
          { discordGuildId: role.guild.id, roleId: role.id, affected: result.affected },
          'a synchronized role was deleted',
        );
      }
    } catch (error) {
      log.error({ err: serializeError(error) }, 'roleDelete failed');
    }
  });

  client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
    try {
      const me = newRole.guild.members.me;
      await handleRoleUpdated({
        discordGuildId: newRole.guild.id,
        discordRoleId: newRole.id,
        roleName: newRole.name,
        position: newRole.position,
        botHighestPosition: me?.roles?.highest?.position,
        managed: newRole.managed,
      });
    } catch (error) {
      log.error({ err: serializeError(error) }, 'roleUpdate failed');
    }
  });

  client.on(Events.Error, (error) => {
    log.error({ err: serializeError(error) }, 'discord client error');
  });
}

/**
 * Best-effort attribution of a manual role change.
 *
 * Discord does not include the actor in `guildMemberUpdate`, so the audit log is the
 * only source. It needs the View Audit Log permission and can lag slightly, so this is
 * treated as a bonus for the audit record rather than something to depend on: a null
 * result changes nothing about how the event is processed.
 */
async function findRoleChangeExecutor(member) {
  try {
    const logs = await member.guild.fetchAuditLogs({
      type: AuditLogEvent.MemberRoleUpdate,
      limit: 5,
    });

    const entry = logs.entries.find(
      (candidate) =>
        candidate.target?.id === member.id && Date.now() - candidate.createdTimestamp < 10_000,
    );
    return entry?.executor?.id ?? null;
  } catch {
    return null;
  }
}
