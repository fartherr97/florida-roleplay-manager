/**
 * Desired-state computation.
 *
 * Pure: no database, no Discord, no clock beyond what the caller passes in. Given a
 * member's roster data and the current Discord state, it answers two questions for
 * every approved guild:
 *
 *   1. which roles should this member have?           (`desired`)
 *   2. which roles is the platform allowed to remove?  (`controlled`)
 *
 * The second question is the important one. A role is only ever controlled when the
 * platform can actually compute its correct value - from roster data, from a manual
 * grant, or from an enabled mapping that is authoritative for it. Everything else is
 * the member's own business and is never touched, which is what stops the engine from
 * stripping community, cosmetic or notification roles.
 *
 * ## Authority rules
 *
 * | direction | authority       | behaviour                                        |
 * |-----------|-----------------|--------------------------------------------------|
 * | ONE_WAY   | SOURCE_DISCORD  | target mirrors the source role                   |
 * | ONE_WAY   | TARGET_DISCORD  | source mirrors the target role                   |
 * | ONE_WAY   | ROSTER          | target mirrors the roster-derived source value   |
 * | TWO_WAY   | SOURCE_DISCORD  | source wins; target is corrected to match        |
 * | TWO_WAY   | TARGET_DISCORD  | target wins; source is corrected to match        |
 * | TWO_WAY   | MANUAL / SYSTEM | union for adds; reconciliation never removes     |
 *
 * The TWO_WAY union rule exists because "both sides are equal" has no deterministic
 * answer when the two sides disagree: picking one would make the reconciler flip-flop
 * on every run. Under union, adds converge and removals propagate through the event
 * handler instead, which knows which side actually changed.
 */
import {
  ACTIVE_MEMBERSHIP_STATUSES,
  AuthoritySource,
  MappingDirection,
  MembershipStatus,
  ROSTER_DRIVEN_PURPOSES,
  RolePurpose,
} from '@frm/shared';

/** How many passes the mapping fixpoint is allowed before we give up and warn. */
const MAX_MAPPING_PASSES = 10;

/**
 * @typedef {object} DesiredEntry
 * @property {string} reason human readable explanation, stored on the SyncAction
 * @property {string} source AuthoritySource that decided this
 * @property {number} priority
 * @property {string|null} managedRoleId
 * @property {string|null} mappingId
 *
 * @typedef {object} DesiredState
 * @property {Map<string, Map<string, DesiredEntry>>} desired   guildId -> roleId -> entry
 * @property {Map<string, Set<string>>} controlled              guildId -> removable roleIds
 * @property {Array<{type: string, message: string, details?: object}>} conflicts
 * @property {Array<{type: string, message: string, details?: object}>} warnings
 */

/**
 * @param {object} context see `context.js` for how this is loaded
 * @param {Map<string, Set<string>>} actualByGuild guildDiscordId -> current role ids
 * @param {object} [options]
 * @param {boolean} [options.mappingOnly]
 *   Evaluate mappings only, and treat no roster-driven role as removable.
 *
 *   This is the mode used for a Discord account that has no platform member record. We
 *   have no roster data for that person, so we cannot compute the correct value of
 *   their rank or membership roles - and the engine's central rule is that it only
 *   removes roles whose correct value it can compute. Stripping department roles from
 *   somebody simply because they are unlinked would be a mass-removal bug waiting to
 *   happen; the scheduled sweep reports them as an issue for a human instead.
 * @returns {DesiredState}
 */
export function computeDesiredState(context, actualByGuild = new Map(), options = {}) {
  const desired = new Map();
  const controlled = new Map();
  const conflicts = [];
  const warnings = [];

  for (const guild of context.guilds) {
    desired.set(guild.discordGuildId, new Map());
    controlled.set(guild.discordGuildId, new Set());
  }

  const rolesByGuild = groupBy(context.managedRoles, (role) => role.discordGuildId);

  if (!options.mappingOnly) {
    // --- 1. roster-driven roles --------------------------------------------
    applyRosterRoles({ context, desired, controlled, rolesByGuild, warnings });

    // --- 2. manual grants --------------------------------------------------
    applyManualGrants({ context, desired, controlled, rolesByGuild });
  }

  // --- 3. mappings ---------------------------------------------------------
  applyMappings({ context, desired, controlled, actualByGuild, conflicts, warnings });

  return { desired, controlled, conflicts, warnings };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

function applyRosterRoles({ context, desired, controlled, rolesByGuild, warnings }) {
  const activeMemberships = context.memberships.filter((membership) =>
    ACTIVE_MEMBERSHIP_STATUSES.includes(membership.status),
  );
  const activeDepartmentIds = new Set(activeMemberships.map((m) => m.departmentId));
  const membershipByDepartment = new Map(activeMemberships.map((m) => [m.departmentId, m]));
  const certificationIds = new Set(context.certificationIds ?? []);
  const subdivisionIds = new Set(context.subdivisionIds ?? []);

  for (const guild of context.guilds) {
    const guildRoles = rolesByGuild.get(guild.discordGuildId) ?? [];

    for (const role of guildRoles) {
      if (!role.managedByPlatform) continue;
      if (!ROSTER_DRIVEN_PURPOSES.includes(role.purpose)) continue;

      // Every roster-driven managed role is controlled: the roster always knows
      // whether the member should have it, including when the answer is "no".
      controlled.get(guild.discordGuildId).add(role.discordRoleId);

      const membership = role.departmentId ? membershipByDepartment.get(role.departmentId) : null;
      const wanted = isRosterRoleWanted({
        role,
        membership,
        activeDepartmentIds,
        certificationIds,
        subdivisionIds,
      });

      if (wanted) {
        setDesired(desired, guild.discordGuildId, role.discordRoleId, {
          reason: wanted.reason,
          source: AuthoritySource.ROSTER,
          priority: Number.MAX_SAFE_INTEGER, // roster always beats a mapping
          managedRoleId: role.id,
          mappingId: null,
        });
      }
    }
  }

  // A member who belongs to a department that has no managed roles at all is almost
  // certainly a misconfiguration; surface it rather than silently doing nothing.
  for (const membership of activeMemberships) {
    const hasAnyRole = context.managedRoles.some(
      (role) => role.departmentId === membership.departmentId && role.managedByPlatform,
    );
    if (!hasAnyRole) {
      warnings.push({
        type: 'DEPARTMENT_HAS_NO_MANAGED_ROLES',
        message: `Department ${membership.departmentKey ?? membership.departmentId} has no managed Discord roles configured.`,
        details: { departmentId: membership.departmentId },
      });
    }
  }
}

/**
 * Decides whether a single roster-driven role is wanted, honouring the department's
 * LOA and suspension policy.
 *
 * @returns {{reason: string}|null}
 */
function isRosterRoleWanted({
  role,
  membership,
  activeDepartmentIds,
  certificationIds,
  subdivisionIds,
}) {
  switch (role.purpose) {
    case RolePurpose.DEPARTMENT_MEMBERSHIP: {
      if (!membership) return null;
      if (suppressesMembershipRoles(membership)) return null;
      return {
        reason: `department membership: ${membership.departmentName ?? membership.departmentId}`,
      };
    }

    case RolePurpose.RANK: {
      if (!membership) return null;
      if (membership.rankId !== role.rankId) return null;
      if (suppressesRankRoles(membership)) return null;
      return { reason: `rank: ${membership.rankName ?? role.name}` };
    }

    case RolePurpose.SUPERVISOR: {
      if (!membership?.rank?.isSupervisor) return null;
      if (suppressesRankRoles(membership)) return null;
      return { reason: `supervisor rank: ${membership.rankName ?? ''}`.trim() };
    }

    case RolePurpose.COMMAND: {
      if (!membership?.rank?.isCommand) return null;
      if (suppressesRankRoles(membership)) return null;
      return { reason: `command rank: ${membership.rankName ?? ''}`.trim() };
    }

    case RolePurpose.STATUS_LOA: {
      if (!membership || membership.status !== MembershipStatus.LOA) return null;
      return { reason: 'status: leave of absence' };
    }

    case RolePurpose.STATUS_SUSPENDED: {
      if (!membership || membership.status !== MembershipStatus.SUSPENDED) return null;
      return { reason: 'status: suspended' };
    }

    case RolePurpose.CERTIFICATION: {
      if (!role.certificationId || !certificationIds.has(role.certificationId)) return null;
      // A department-scoped certification role requires membership of that department.
      if (role.departmentId && !activeDepartmentIds.has(role.departmentId)) return null;
      if (membership && suppressesMembershipRoles(membership)) return null;
      return { reason: `certification: ${role.name}` };
    }

    case RolePurpose.SUBDIVISION: {
      if (!role.subdivisionId || !subdivisionIds.has(role.subdivisionId)) return null;
      if (role.departmentId && !activeDepartmentIds.has(role.departmentId)) return null;
      if (membership && suppressesMembershipRoles(membership)) return null;
      return { reason: `subdivision: ${role.name}` };
    }

    default:
      return null;
  }
}

function suppressesRankRoles(membership) {
  if (membership.status === MembershipStatus.LOA) {
    return Boolean(membership.department?.removeRankRolesOnLoa);
  }
  if (membership.status === MembershipStatus.SUSPENDED) {
    return membership.department?.removeRankRolesOnSuspension !== false;
  }
  return false;
}

function suppressesMembershipRoles(membership) {
  if (membership.status === MembershipStatus.SUSPENDED) {
    return Boolean(membership.department?.removeMembershipRolesOnSuspension);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Manual grants
// ---------------------------------------------------------------------------

function applyManualGrants({ context, desired, controlled, rolesByGuild }) {
  const grantedRoleIds = new Set(context.manualGrantManagedRoleIds ?? []);

  for (const guild of context.guilds) {
    for (const role of rolesByGuild.get(guild.discordGuildId) ?? []) {
      if (!role.managedByPlatform) continue;
      if (role.purpose !== RolePurpose.MANUAL_GRANT) continue;

      // Manual-authority roles are controlled so that a grant expiring or being
      // revoked actually removes the role on the next reconciliation.
      controlled.get(guild.discordGuildId).add(role.discordRoleId);

      if (grantedRoleIds.has(role.id)) {
        setDesired(desired, guild.discordGuildId, role.discordRoleId, {
          reason: `manual grant: ${role.name}`,
          source: AuthoritySource.MANUAL,
          priority: Number.MAX_SAFE_INTEGER - 1,
          managedRoleId: role.id,
          mappingId: null,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

function applyMappings({ context, desired, controlled, actualByGuild, conflicts, warnings }) {
  const mappings = [...(context.mappings ?? [])]
    .filter((mapping) => mapping.enabled)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  if (mappings.length === 0) return;

  const knownGuilds = new Set(context.guilds.map((guild) => guild.discordGuildId));

  // Mapping chains (A -> B -> C) converge in a single reconciliation because each pass
  // reads the *effective* state produced by the previous pass. Cycles are rejected when
  // a mapping is created, so this terminates; the cap is a belt-and-braces guard.
  let changed = true;
  let passes = 0;
  while (changed && passes < MAX_MAPPING_PASSES) {
    changed = false;
    passes += 1;

    for (const mapping of mappings) {
      if (
        !knownGuilds.has(mapping.sourceDiscordGuildId) ||
        !knownGuilds.has(mapping.targetDiscordGuildId)
      ) {
        // A mapping onto a guild that is no longer approved or has sync disabled is
        // inert; it is reported by the mapping validation sweep, not here.
        continue;
      }

      for (const edge of edgesFor(mapping)) {
        const applied = applyMappingEdge({
          mapping,
          edge,
          desired,
          controlled,
          actualByGuild,
          conflicts,
        });
        if (applied) changed = true;
      }
    }
  }

  if (passes >= MAX_MAPPING_PASSES) {
    warnings.push({
      type: 'MAPPING_FIXPOINT_NOT_REACHED',
      message:
        'Mapping evaluation did not settle. This usually means a mapping chain is longer than ' +
        `${MAX_MAPPING_PASSES} hops or a cycle slipped past validation.`,
    });
  }
}

/**
 * Expands a mapping into the directed edges it implies, together with which side is
 * authoritative for each edge.
 *
 * @returns {Array<{fromGuild: string, fromRole: string, toGuild: string, toRole: string, authoritative: boolean}>}
 */
function edgesFor(mapping) {
  const forward = {
    fromGuild: mapping.sourceDiscordGuildId,
    fromRole: mapping.sourceRoleId,
    toGuild: mapping.targetDiscordGuildId,
    toRole: mapping.targetRoleId,
  };
  const backward = {
    fromGuild: mapping.targetDiscordGuildId,
    fromRole: mapping.targetRoleId,
    toGuild: mapping.sourceDiscordGuildId,
    toRole: mapping.sourceRoleId,
  };

  switch (mapping.authority) {
    case AuthoritySource.TARGET_DISCORD:
      // The target guild decides; the source is corrected to match.
      return [{ ...backward, authoritative: true }];

    case AuthoritySource.SOURCE_DISCORD:
    case AuthoritySource.ROSTER:
    case AuthoritySource.SYSTEM:
      return [{ ...forward, authoritative: true }];

    case AuthoritySource.MANUAL:
    default:
      // No side is authoritative: union semantics, and only for TWO_WAY.
      return mapping.direction === MappingDirection.TWO_WAY
        ? [
            { ...forward, authoritative: false },
            { ...backward, authoritative: false },
          ]
        : [{ ...forward, authoritative: false }];
  }
}

function applyMappingEdge({ mapping, edge, desired, controlled, actualByGuild, conflicts }) {
  const sourceHas = effectiveHas(edge.fromGuild, edge.fromRole, desired, controlled, actualByGuild);
  const targetDesired = desired.get(edge.toGuild);
  const targetControlled = controlled.get(edge.toGuild);
  if (!targetDesired || !targetControlled) return false;

  let changed = false;

  // An authoritative edge with removal enabled means the platform can compute the
  // correct value of the target role, so the role becomes removable.
  if (edge.authoritative && mapping.syncRemove && !targetControlled.has(edge.toRole)) {
    targetControlled.add(edge.toRole);
    changed = true;
  }

  const existing = targetDesired.get(edge.toRole);

  if (sourceHas) {
    if (!mapping.syncAdd) return changed;
    if (existing) return changed;
    targetDesired.set(edge.toRole, {
      reason: `mapping: ${mapping.name}`,
      source: mapping.authority,
      priority: mapping.priority,
      managedRoleId: null,
      mappingId: mapping.id,
    });
    return true;
  }

  // The source does not have the role. Only an authoritative edge with removal enabled
  // may un-desire it, and roster decisions always win.
  if (!edge.authoritative || !mapping.syncRemove) return changed;

  if (existing) {
    if (existing.source === AuthoritySource.ROSTER || existing.source === AuthoritySource.MANUAL) {
      conflicts.push({
        type: 'MAPPING_OVERRIDDEN_BY_ROSTER',
        message:
          `Mapping "${mapping.name}" would remove a role that roster data requires. ` +
          'Roster data wins; the mapping had no effect on this role.',
        details: {
          mappingId: mapping.id,
          discordGuildId: edge.toGuild,
          discordRoleId: edge.toRole,
        },
      });
      return changed;
    }
    if (existing.priority > mapping.priority) {
      conflicts.push({
        type: 'MAPPING_PRIORITY_CONFLICT',
        message:
          `Mappings disagree about a role; the higher priority mapping won. ` +
          `Losing mapping: "${mapping.name}".`,
        details: {
          mappingId: mapping.id,
          discordGuildId: edge.toGuild,
          discordRoleId: edge.toRole,
        },
      });
      return changed;
    }
    // Equal or lower priority already claimed it: a disagreement at the same priority
    // resolves in favour of keeping the role, which is the non-destructive answer.
    if (existing.priority === mapping.priority) {
      conflicts.push({
        type: 'MAPPING_TIE',
        message:
          `Two mappings at the same priority disagree about a role. The role was kept. ` +
          `Set distinct priorities on "${mapping.name}" to resolve this.`,
        details: {
          mappingId: mapping.id,
          discordGuildId: edge.toGuild,
          discordRoleId: edge.toRole,
        },
      });
      return changed;
    }
    targetDesired.delete(edge.toRole);
    return true;
  }

  return changed;
}

/**
 * The state a role will be in once this reconciliation is applied.
 *
 * Using the effective state rather than the raw Discord state is what lets a chain
 * A -> B -> C settle in one pass instead of needing three separate runs.
 */
function effectiveHas(guildId, roleId, desired, controlled, actualByGuild) {
  if (desired.get(guildId)?.has(roleId)) return true;
  if (controlled.get(guildId)?.has(roleId)) return false;
  return Boolean(actualByGuild.get(guildId)?.has(roleId));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function setDesired(desired, guildId, roleId, entry) {
  const guildMap = desired.get(guildId);
  if (!guildMap) return;
  const existing = guildMap.get(roleId);
  if (existing && existing.priority >= entry.priority) return;
  guildMap.set(roleId, entry);
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}
