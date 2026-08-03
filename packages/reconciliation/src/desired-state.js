/**
 * Desired-state computation.
 *
 * Pure: no database, no Discord, no clock beyond what the caller passes in. Given a
 * member's grants and the current Discord state, it answers two questions for every
 * approved guild:
 *
 *   1. which roles should this member have?           (`desired`)
 *   2. which roles is the platform allowed to remove?  (`controlled`)
 *
 * The second question is the important one. A role is only ever controlled when the
 * platform can actually compute its correct value — from an explicit manual grant, or
 * from an enabled mapping that is authoritative for it. Everything else is the member's
 * own business and is never touched, which is what stops the engine from stripping
 * community, cosmetic or notification roles.
 *
 * ## Authority rules
 *
 * | direction | authority       | behaviour                                        |
 * |-----------|-----------------|--------------------------------------------------|
 * | ONE_WAY   | SOURCE_DISCORD  | target mirrors the source role                   |
 * | ONE_WAY   | TARGET_DISCORD  | source mirrors the target role                   |
 * | TWO_WAY   | SOURCE_DISCORD  | source wins; target is corrected to match        |
 * | TWO_WAY   | TARGET_DISCORD  | target wins; source is corrected to match        |
 * | TWO_WAY   | MANUAL / SYSTEM | union for adds; reconciliation never removes     |
 *
 * The TWO_WAY union rule exists because "both sides are equal" has no deterministic
 * answer when the two sides disagree: picking one would make the reconciler flip-flop
 * on every run. Under union, adds converge and removals propagate through the event
 * handler instead, which knows which side actually changed.
 */
import { AuthoritySource, MappingDirection, RolePurpose } from '@frm/shared';

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
 *   Evaluate mappings only, ignoring manual grants. Used for a Discord account with no
 *   platform member record, which by definition cannot hold a grant.
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
    applyManualGrants({ context, desired, controlled, rolesByGuild });
  }

  applyMappings({ context, desired, controlled, actualByGuild, conflicts, warnings });

  return { desired, controlled, conflicts, warnings };
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
          priority: Number.MAX_SAFE_INTEGER,
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
  // may un-desire it, and manual grants always win.
  if (!edge.authoritative || !mapping.syncRemove) return changed;

  if (existing) {
    if (existing.source === AuthoritySource.MANUAL && existing.mappingId === null) {
      conflicts.push({
        type: 'MAPPING_OVERRIDDEN_BY_GRANT',
        message:
          `Mapping "${mapping.name}" would remove a role that an active manual grant requires. ` +
          'The grant wins; the mapping had no effect on this role.',
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
