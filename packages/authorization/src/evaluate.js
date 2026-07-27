/**
 * Authorization evaluation.
 *
 * Deliberately pure: it takes an actor snapshot and a requirement and returns a
 * decision. No database access, no Discord access, no I/O. That makes every rule in
 * here directly testable, and it means the same function runs for a slash command and
 * for an HTTP request — there is exactly one implementation of "may they do this?".
 *
 * An actor is authorized only when ALL of these hold:
 *   1. the account is active
 *   2. they hold the capability
 *   3. an assignment's scope covers the resource
 *   4. their permission level meets the capability's minimum
 *   5. the target's rank is within the assignment's rank ceiling (before AND after)
 *   6. the target's authority level is below the actor's own
 *   7. the action is not self-directed (unless explicitly allowed)
 */
import {
  AuthorizationError,
  PermissionScopeType,
  RankCeilingError,
  SelfManagementError,
  UserStatus,
  getCapability,
} from '@frm/shared';

/** Machine-readable denial reasons, used for audit records and error selection. */
export const DenialReason = Object.freeze({
  INACTIVE_ACCOUNT: 'INACTIVE_ACCOUNT',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
  MISSING_CAPABILITY: 'MISSING_CAPABILITY',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  LEVEL_TOO_LOW: 'LEVEL_TOO_LOW',
  RANK_CEILING: 'RANK_CEILING',
  LEVEL_CEILING: 'LEVEL_CEILING',
  SELF_MANAGEMENT: 'SELF_MANAGEMENT',
});

/**
 * Ordering used to pick which failure to report when several assignments fail for
 * different reasons. The most specific, most actionable message wins.
 */
const REASON_PRIORITY = [
  DenialReason.SELF_MANAGEMENT,
  DenialReason.LEVEL_CEILING,
  DenialReason.RANK_CEILING,
  DenialReason.OUT_OF_SCOPE,
  DenialReason.LEVEL_TOO_LOW,
  DenialReason.MISSING_CAPABILITY,
];

/**
 * @typedef {object} ActorSnapshot
 * @property {{id: string, displayName: string, status: string, permissionLevel: number}} user
 * @property {string|null} discordUserId
 * @property {AssignmentSnapshot[]} assignments
 * @property {boolean} [isSystem] internal actor used by scheduled jobs
 *
 * @typedef {object} AssignmentSnapshot
 * @property {string} id
 * @property {string} capabilityKey
 * @property {string} scopeType
 * @property {string} scopeId empty string for GLOBAL
 * @property {number|null} maxRankOrder
 * @property {number|null} maxPermissionLevel
 *
 * @typedef {object} ResourceScope
 * @property {string} [guildId] internal ApprovedGuild id
 * @property {string} [departmentId]
 * @property {string} [subdivisionId]
 *
 * @typedef {object} TargetDescriptor
 * @property {string} [userId]
 * @property {number} [permissionLevel]
 * @property {number} [currentRankOrder] rank the target holds now
 * @property {number} [resultingRankOrder] rank the target would hold after the action
 *
 * @typedef {object} Requirement
 * @property {string} capability
 * @property {ResourceScope} [scope]
 * @property {TargetDescriptor} [target]
 * @property {boolean} [allowSelf] permit the actor to act on their own record
 *
 * @typedef {object} Decision
 * @property {boolean} allowed
 * @property {string} [reason]
 * @property {string} [message]
 * @property {AssignmentSnapshot} [assignment]
 */

/**
 * Does an assignment's scope cover the resource being acted on?
 *
 * A GLOBAL assignment covers everything. A DEPARTMENT assignment covers actions on
 * that department (and, when the caller supplies it, that department's guild, because
 * the caller resolves a department guild to its department before evaluating).
 *
 * @param {AssignmentSnapshot} assignment
 * @param {ResourceScope} scope
 */
export function scopeCovers(assignment, scope = {}) {
  switch (assignment.scopeType) {
    case PermissionScopeType.GLOBAL:
      return true;
    case PermissionScopeType.GUILD:
      return Boolean(scope.guildId) && assignment.scopeId === scope.guildId;
    case PermissionScopeType.DEPARTMENT:
      return Boolean(scope.departmentId) && assignment.scopeId === scope.departmentId;
    case PermissionScopeType.SUBDIVISION:
      return Boolean(scope.subdivisionId) && assignment.scopeId === scope.subdivisionId;
    default:
      return false;
  }
}

/**
 * Evaluates a requirement against an actor.
 *
 * @param {ActorSnapshot} actor
 * @param {Requirement} requirement
 * @returns {Decision}
 */
export function evaluate(actor, requirement) {
  const { capability, scope = {}, target = {}, allowSelf = false } = requirement;

  if (!actor || !actor.user) {
    return deny(DenialReason.MISSING_CAPABILITY, 'You do not have an account on this platform.');
  }

  // The system actor is constructed internally (scheduled reconciliation, event-driven
  // propagation). It can never originate from user input.
  if (actor.isSystem) return { allowed: true, assignment: null };

  if (actor.user.status !== UserStatus.ACTIVE) {
    return deny(
      DenialReason.INACTIVE_ACCOUNT,
      'Your platform account is not active. Contact an administrator.',
    );
  }

  const definition = getCapability(capability);
  if (!definition) {
    return deny(DenialReason.UNKNOWN_CAPABILITY, 'That action is not recognised.');
  }

  // Self-management is checked before anything else: no combination of grants lets a
  // user promote, suspend or re-permission themselves.
  if (!allowSelf && target.userId && target.userId === actor.user.id) {
    return deny(DenialReason.SELF_MANAGEMENT, `You cannot use ${capability} on your own record.`);
  }

  // Capability possession is checked before the authority-level minimum so that
  // somebody who has neither is told the actionable thing ("you do not have this
  // permission") rather than the incidental one. Both outcomes deny.
  const candidates = actor.assignments.filter((a) => a.capabilityKey === capability);
  if (candidates.length === 0) {
    return deny(DenialReason.MISSING_CAPABILITY, `You do not have the ${capability} permission.`);
  }

  if (actor.user.permissionLevel < definition.minLevel) {
    return deny(DenialReason.LEVEL_TOO_LOW, 'Your authority level is too low for this action.');
  }

  // A user may never act on somebody at or above their own authority level. This is
  // what stops a department head from demoting a global administrator.
  if (
    typeof target.permissionLevel === 'number' &&
    target.permissionLevel >= actor.user.permissionLevel
  ) {
    return deny(
      DenialReason.LEVEL_CEILING,
      'That member has the same or higher authority than you.',
    );
  }

  /** @type {Decision|null} */
  let bestFailure = null;

  for (const assignment of candidates) {
    // Defence in depth: a grant stored at a scope type the capability does not support
    // is treated as invalid rather than as a wildcard.
    if (!definition.allowedScopes.includes(assignment.scopeType)) {
      bestFailure = worse(
        bestFailure,
        deny(DenialReason.OUT_OF_SCOPE, `You do not have ${capability} here.`),
      );
      continue;
    }

    if (!scopeCovers(assignment, scope)) {
      bestFailure = worse(
        bestFailure,
        deny(
          DenialReason.OUT_OF_SCOPE,
          `You do not have ${capability} for this department or guild.`,
        ),
      );
      continue;
    }

    if (typeof assignment.maxPermissionLevel === 'number') {
      if (
        typeof target.permissionLevel === 'number' &&
        target.permissionLevel > assignment.maxPermissionLevel
      ) {
        bestFailure = worse(
          bestFailure,
          deny(
            DenialReason.LEVEL_CEILING,
            'That member is above the maximum authority level you may manage.',
          ),
        );
        continue;
      }
    }

    if (typeof assignment.maxRankOrder === 'number') {
      const ranks = [target.currentRankOrder, target.resultingRankOrder].filter(
        (value) => typeof value === 'number',
      );
      const exceeding = ranks.find((order) => order > assignment.maxRankOrder);
      if (exceeding !== undefined) {
        bestFailure = worse(
          bestFailure,
          deny(
            DenialReason.RANK_CEILING,
            'That rank is above the maximum rank you are allowed to manage.',
            { maxRankOrder: assignment.maxRankOrder, attemptedRankOrder: exceeding },
          ),
        );
        continue;
      }
    }

    return { allowed: true, assignment };
  }

  return bestFailure ?? deny(DenialReason.MISSING_CAPABILITY, `You do not have ${capability}.`);
}

/**
 * Evaluates and throws the appropriate typed error when denied.
 *
 * @param {ActorSnapshot} actor
 * @param {Requirement} requirement
 * @returns {Decision}
 */
export function authorize(actor, requirement) {
  const decision = evaluate(actor, requirement);
  if (decision.allowed) return decision;

  const details = {
    capability: requirement.capability,
    reason: decision.reason,
    ...decision.details,
  };

  switch (decision.reason) {
    case DenialReason.SELF_MANAGEMENT:
      throw new SelfManagementError(requirement.capability);
    case DenialReason.RANK_CEILING:
      throw new RankCeilingError(decision.message, details);
    default:
      throw new AuthorizationError(decision.message, details);
  }
}

/**
 * Convenience check for UI affordances (which commands to show, which buttons to
 * render). Never a substitute for `authorize` at the point of action.
 *
 * @param {ActorSnapshot} actor
 * @param {string} capability
 */
export function hasCapabilityAnywhere(actor, capability) {
  if (!actor?.user) return false;
  if (actor.isSystem) return true;
  if (actor.user.status !== UserStatus.ACTIVE) return false;
  return actor.assignments.some((assignment) => assignment.capabilityKey === capability);
}

/**
 * The department ids an actor may act on with a capability, or `null` meaning "all"
 * when they hold it globally. Used to constrain list queries so a department head only
 * ever sees their own rosters.
 *
 * @param {ActorSnapshot} actor
 * @param {string} capability
 * @returns {string[]|null}
 */
export function departmentScopeFilter(actor, capability) {
  if (actor?.isSystem) return null;
  const assignments = (actor?.assignments ?? []).filter((a) => a.capabilityKey === capability);
  if (assignments.some((a) => a.scopeType === PermissionScopeType.GLOBAL)) return null;
  return assignments
    .filter((a) => a.scopeType === PermissionScopeType.DEPARTMENT)
    .map((a) => a.scopeId);
}

/**
 * The guild ids an actor may act on with a capability, or `null` for all.
 * @param {ActorSnapshot} actor
 * @param {string} capability
 * @returns {string[]|null}
 */
export function guildScopeFilter(actor, capability) {
  if (actor?.isSystem) return null;
  const assignments = (actor?.assignments ?? []).filter((a) => a.capabilityKey === capability);
  if (assignments.some((a) => a.scopeType === PermissionScopeType.GLOBAL)) return null;
  return assignments.filter((a) => a.scopeType === PermissionScopeType.GUILD).map((a) => a.scopeId);
}

function deny(reason, message, details = {}) {
  return { allowed: false, reason, message, details };
}

function worse(current, candidate) {
  if (!current) return candidate;
  const currentIndex = REASON_PRIORITY.indexOf(current.reason);
  const candidateIndex = REASON_PRIORITY.indexOf(candidate.reason);
  return candidateIndex < currentIndex ? candidate : current;
}
