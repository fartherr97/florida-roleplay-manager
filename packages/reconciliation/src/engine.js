/**
 * The reconciliation engine.
 *
 * Ties the pieces together: read live Discord state, compute the desired state, diff
 * them, and return a plan. Planning never writes anything, which is what makes dry-run
 * and preview exactly the same code path as a real run.
 */
import { createLogger } from '@frm/logging';
import { computeDesiredState } from './desired-state.js';
import { aggregatePlans, diffMemberState, summarizePlan } from './diff.js';
import {
  buildReconciliationContext,
  loadMemberRoster,
  loadPlatformContext,
  relevantGuilds,
} from './context.js';

const log = createLogger('reconciliation');

/**
 * Reads the member's current roles in every relevant guild.
 *
 * A `null` entry means "not in that guild", which is different from "in the guild with
 * no managed roles" and is reported differently.
 *
 * @param {object} gateway
 * @param {string} discordUserId
 * @param {Array<{discordGuildId: string}>} guilds
 * @returns {Promise<Map<string, Set<string>|null>>}
 */
export async function readActualState(gateway, discordUserId, guilds) {
  const entries = await Promise.all(
    guilds.map(async (guild) => {
      try {
        const member = await gateway.getMember(guild.discordGuildId, discordUserId);
        return [guild.discordGuildId, member ? new Set(member.roleIds) : null];
      } catch (error) {
        // A guild we cannot read is reported as "member missing" rather than failing the
        // whole plan: one unavailable guild must not block the other five.
        log.warn(
          { discordGuildId: guild.discordGuildId, discordUserId, err: error?.message },
          'could not read member state',
        );
        return [guild.discordGuildId, null];
      }
    }),
  );
  return new Map(entries);
}

/**
 * Plans the reconciliation of a single member.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {object} params.platform result of `loadPlatformContext`
 * @param {object} params.roster result of `loadMemberRoster`
 * @returns {Promise<{plan: object, context: object, actualByGuild: Map<string, Set<string>|null>}>}
 */
export async function planMemberReconciliation({ gateway, platform, roster }) {
  const context = buildReconciliationContext(platform, roster);
  const guilds = relevantGuilds(context);
  const { discordUserId } = context.member;

  if (!discordUserId) {
    return {
      context,
      actualByGuild: new Map(),
      plan: {
        actions: [],
        conflicts: [],
        warnings: [
          {
            type: 'MEMBER_NOT_LINKED',
            message:
              'This member has no linked Discord account, so no roles can be synchronized for them.',
            details: { userId: context.member.id },
          },
        ],
        guildsMissingMember: [],
        rolesReviewed: 0,
      },
    };
  }

  const actualByGuild = await readActualState(gateway, discordUserId, guilds);
  const desiredState = computeDesiredState(context, actualByGuild);
  const plan = diffMemberState({ discordUserId, desiredState, actualByGuild, guilds });

  return { plan, context, actualByGuild };
}

/**
 * Plans reconciliation for a Discord account with no platform member record.
 *
 * Only mappings are evaluated, and only mapping-controlled roles can be removed. This
 * is what lets a community interest role stay synchronized across guilds for people who
 * are not on any department roster, without the engine ever touching roles whose
 * correct value it cannot compute.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {object} params.platform result of `loadPlatformContext`
 * @param {string} params.discordUserId
 */
export async function planForUnlinkedDiscordUser({ gateway, platform, discordUserId }) {
  const context = {
    member: { id: null, displayName: discordUserId, discordUserId },
    guilds: platform.guilds,
    managedRoles: platform.managedRoles,
    mappings: platform.mappings,
    memberships: [],
    certificationIds: [],
    subdivisionIds: [],
    manualGrantManagedRoleIds: [],
  };

  const guilds = relevantGuilds(context);
  const actualByGuild = await readActualState(gateway, discordUserId, guilds);
  const desiredState = computeDesiredState(context, actualByGuild, { mappingOnly: true });
  const plan = diffMemberState({ discordUserId, desiredState, actualByGuild, guilds });

  return { plan, context, actualByGuild };
}

/**
 * Convenience wrapper that loads everything itself. Used by single-member resyncs.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {string} params.userId
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function planForUser({ gateway, userId, prisma }) {
  const platform = await loadPlatformContext(prisma);
  const roster = await loadMemberRoster(userId, { prisma });
  if (!roster) return null;
  return planMemberReconciliation({ gateway, platform, roster });
}

/**
 * Plans reconciliation for many members, reusing one platform context.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {string[]} params.userIds
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 * @param {(progress: {completed: number, total: number}) => void} [params.onProgress]
 * @param {number} [params.concurrency]
 */
export async function planForUsers({ gateway, userIds, prisma, onProgress, concurrency = 5 }) {
  const platform = await loadPlatformContext(prisma);
  const results = [];
  let completed = 0;

  // Bounded concurrency: Discord rate limits are per-route, and firing 400 member
  // fetches at once is the fastest way to get the bot throttled.
  for (let index = 0; index < userIds.length; index += concurrency) {
    const batch = userIds.slice(index, index + concurrency);
    const planned = await Promise.all(
      batch.map(async (userId) => {
        const roster = await loadMemberRoster(userId, { prisma });
        if (!roster) return null;
        const { plan } = await planMemberReconciliation({ gateway, platform, roster });
        return { userId, discordUserId: roster.member.discordUserId, plan };
      }),
    );
    for (const entry of planned) {
      if (entry) results.push(entry);
    }
    completed += batch.length;
    onProgress?.({ completed, total: userIds.length });
  }

  return { platform, memberPlans: results, aggregate: aggregatePlans(results) };
}

export { computeDesiredState, diffMemberState, summarizePlan, aggregatePlans };
