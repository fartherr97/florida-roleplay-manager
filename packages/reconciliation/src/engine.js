/**
 * The reconciliation engine.
 *
 * Ties the pieces together: read live Discord state, compute the desired state, diff
 * them, and return a plan. Planning never writes anything, which is what makes dry-run
 * and preview exactly the same code path as a real run.
 *
 * Everything is keyed on a Discord account, not on a platform member. Mappings apply to
 * whoever holds the source role, whether or not they have ever signed in — a member
 * record only adds manual grants on top.
 */
import { createLogger } from '@frm/logging';
import { computeDesiredState } from './desired-state.js';
import { aggregatePlans, diffMemberState, summarizePlan } from './diff.js';
import {
  buildReconciliationContext,
  loadMemberGrants,
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
 * Plans the reconciliation of one Discord account.
 *
 * `member` is optional: when supplied, the account's manual grants are included.
 * Without it the plan is mapping-only, which is exactly right for a Discord user who
 * has no platform record and therefore cannot hold a grant.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {object} params.platform result of `loadPlatformContext`
 * @param {string} params.discordUserId
 * @param {object} [params.member] result of `loadMemberGrants`
 * @returns {Promise<{plan: object, context: object, actualByGuild: Map<string, Set<string>|null>}>}
 */
export async function planForDiscordUser({ gateway, platform, discordUserId, member = null }) {
  const context = buildReconciliationContext(
    platform,
    member ?? {
      member: { id: null, displayName: discordUserId, discordUserId },
      manualGrantManagedRoleIds: [],
    },
  );

  const guilds = relevantGuilds(context);
  const actualByGuild = await readActualState(gateway, discordUserId, guilds);
  const desiredState = computeDesiredState(context, actualByGuild, { mappingOnly: !member });
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
  const member = await loadMemberGrants(userId, { prisma });
  if (!member) return null;

  if (!member.member.discordUserId) {
    return {
      context: buildReconciliationContext(platform, member),
      actualByGuild: new Map(),
      plan: {
        actions: [],
        conflicts: [],
        warnings: [
          {
            type: 'MEMBER_NOT_LINKED',
            message:
              'This member has no linked Discord account, so no roles can be synchronized for them.',
            details: { userId },
          },
        ],
        guildsMissingMember: [],
        rolesReviewed: 0,
      },
    };
  }

  return planForDiscordUser({
    gateway,
    platform,
    discordUserId: member.member.discordUserId,
    member,
  });
}

/**
 * Plans reconciliation for many Discord accounts, reusing one platform context.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {Array<{discordUserId: string, userId?: string|null}>} params.targets
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 * @param {(progress: {completed: number, total: number}) => void} [params.onProgress]
 * @param {number} [params.concurrency]
 */
export async function planForTargets({
  gateway,
  targets,
  prisma,
  onProgress,
  concurrency = 5,
  platform: providedPlatform,
}) {
  const platform = providedPlatform ?? (await loadPlatformContext(prisma));
  const results = [];
  let completed = 0;

  // Bounded concurrency: Discord rate limits are per-route, and firing 400 member
  // fetches at once is the fastest way to get the bot throttled.
  for (let index = 0; index < targets.length; index += concurrency) {
    const batch = targets.slice(index, index + concurrency);
    const planned = await Promise.all(
      batch.map(async (target) => {
        const member = target.userId ? await loadMemberGrants(target.userId, { prisma }) : null;
        const { plan } = await planForDiscordUser({
          gateway,
          platform,
          discordUserId: target.discordUserId,
          member,
        });
        return { userId: target.userId ?? null, discordUserId: target.discordUserId, plan };
      }),
    );
    results.push(...planned.filter(Boolean));
    completed += batch.length;
    onProgress?.({ completed, total: targets.length });
  }

  return { platform, memberPlans: results, aggregate: aggregatePlans(results) };
}

export { computeDesiredState, diffMemberState, summarizePlan, aggregatePlans };
