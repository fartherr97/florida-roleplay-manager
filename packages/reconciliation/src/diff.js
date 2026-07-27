/**
 * The diff step: desired state − actual state = required changes.
 *
 * Deterministic (actions always come out in the same order) and idempotent (running it
 * against a converged state produces zero actions).
 */
import { SyncActionType, SyncIssueType } from '@frm/shared';

/**
 * @typedef {object} PlannedAction
 * @property {string} action ADD_ROLE | REMOVE_ROLE
 * @property {string} discordGuildId
 * @property {string} discordUserId
 * @property {string} discordRoleId
 * @property {string} reason
 * @property {string|null} managedRoleId
 * @property {string|null} mappingId
 *
 * @typedef {object} ReconciliationPlan
 * @property {PlannedAction[]} actions
 * @property {Array<object>} warnings
 * @property {Array<object>} conflicts
 * @property {string[]} guildsMissingMember
 * @property {number} rolesReviewed
 */

/**
 * @param {object} params
 * @param {string} params.discordUserId
 * @param {import('./desired-state.js').DesiredState} params.desiredState
 * @param {Map<string, Set<string>|null>} params.actualByGuild
 *   guildDiscordId -> role ids, or `null` when the member is not in that guild
 * @param {Array<{discordGuildId: string, name: string}>} params.guilds
 * @returns {ReconciliationPlan}
 */
export function diffMemberState({ discordUserId, desiredState, actualByGuild, guilds }) {
  const { desired, controlled, conflicts, warnings } = desiredState;
  /** @type {PlannedAction[]} */
  const actions = [];
  const guildsMissingMember = [];
  let rolesReviewed = 0;

  // Sorted so that a plan for the same state is always byte-identical: this is what
  // makes previews trustworthy and diffs between runs meaningful.
  const orderedGuilds = [...guilds].sort((a, b) =>
    a.discordGuildId.localeCompare(b.discordGuildId),
  );

  for (const guild of orderedGuilds) {
    const guildId = guild.discordGuildId;
    const actual = actualByGuild.get(guildId);
    const desiredRoles = desired.get(guildId) ?? new Map();
    const controlledRoles = controlled.get(guildId) ?? new Set();

    rolesReviewed += controlledRoles.size;

    // The member is not in this guild. Roles cannot be changed there, but that is only
    // a problem worth reporting when the platform actually wants them to have roles.
    if (actual === null || actual === undefined) {
      guildsMissingMember.push(guildId);
      if (desiredRoles.size > 0) {
        warnings.push({
          type: SyncIssueType.MEMBER_NOT_IN_GUILD,
          message: `Member is not in ${guild.name}, so ${desiredRoles.size} role(s) could not be applied there.`,
          details: { discordGuildId: guildId, discordUserId, roleCount: desiredRoles.size },
        });
      }
      continue;
    }

    // Additions: everything desired that is not already present.
    for (const [roleId, entry] of [...desiredRoles.entries()].sort(sortByKey)) {
      if (actual.has(roleId)) continue;
      actions.push({
        action: SyncActionType.ADD_ROLE,
        discordGuildId: guildId,
        discordUserId,
        discordRoleId: roleId,
        reason: entry.reason,
        managedRoleId: entry.managedRoleId ?? null,
        mappingId: entry.mappingId ?? null,
      });
    }

    // Removals: only ever roles the platform controls. A role the member holds that the
    // platform does not control is left completely alone - this is the guarantee that
    // the bot never strips unmanaged roles.
    for (const roleId of [...controlledRoles].sort()) {
      if (!actual.has(roleId)) continue;
      if (desiredRoles.has(roleId)) continue;
      actions.push({
        action: SyncActionType.REMOVE_ROLE,
        discordGuildId: guildId,
        discordUserId,
        discordRoleId: roleId,
        reason: 'no longer granted by roster, mapping or manual grant',
        managedRoleId: null,
        mappingId: null,
      });
    }
  }

  return {
    actions,
    warnings,
    conflicts,
    guildsMissingMember,
    rolesReviewed,
  };
}

function sortByKey(a, b) {
  return a[0].localeCompare(b[0]);
}

/**
 * Summary used by previews and progress embeds.
 * @param {ReconciliationPlan} plan
 */
export function summarizePlan(plan) {
  const adds = plan.actions.filter((action) => action.action === SyncActionType.ADD_ROLE);
  const removes = plan.actions.filter((action) => action.action === SyncActionType.REMOVE_ROLE);
  return {
    totalActions: plan.actions.length,
    addCount: adds.length,
    removeCount: removes.length,
    guildsMissingMember: plan.guildsMissingMember.length,
    conflictCount: plan.conflicts.length,
    warningCount: plan.warnings.length,
    rolesReviewed: plan.rolesReviewed,
  };
}

/**
 * Merges many member plans into one aggregate plan (department, guild and global
 * resyncs are just a lot of member plans).
 *
 * @param {Array<{discordUserId: string, plan: ReconciliationPlan}>} memberPlans
 */
export function aggregatePlans(memberPlans) {
  const actions = [];
  const conflicts = [];
  const warnings = [];
  const missing = new Set();
  let rolesReviewed = 0;

  for (const { plan } of memberPlans) {
    actions.push(...plan.actions);
    conflicts.push(...plan.conflicts);
    warnings.push(...plan.warnings);
    plan.guildsMissingMember.forEach((guildId) => missing.add(guildId));
    rolesReviewed += plan.rolesReviewed;
  }

  return {
    actions,
    conflicts,
    warnings,
    guildsMissingMember: [...missing],
    rolesReviewed,
    membersReviewed: memberPlans.length,
    membersWithChanges: memberPlans.filter(({ plan }) => plan.actions.length > 0).length,
  };
}
