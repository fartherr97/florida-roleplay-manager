/**
 * Permission-granting rules.
 *
 * Granting is the highest-risk operation in the platform: it is the direct path to
 * privilege escalation. The rules here are deliberately conservative.
 *
 *   - You cannot grant a capability you do not hold yourself.
 *   - You cannot grant it in a scope wider than your own.
 *   - You cannot grant an authority ceiling at or above your own level.
 *   - You cannot grant anything to yourself.
 *   - You cannot modify the permissions of somebody at or above your own level.
 */
import {
  AuthorizationError,
  PermissionScopeType,
  SelfManagementError,
  ValidationError,
  getCapability,
} from '@frm/shared';
import { authorize, scopeCovers } from './evaluate.js';

/**
 * @param {import('./evaluate.js').ActorSnapshot} actor
 * @param {object} request
 * @param {string} request.capability capability being granted
 * @param {string} request.scopeType
 * @param {string} request.scopeId empty string for GLOBAL
 * @param {number|null} [request.maxPermissionLevel]
 * @param {{id: string, permissionLevel: number}} request.targetUser
 */
export function assertCanGrant(actor, request) {
  const { capability, scopeType, scopeId = '', maxPermissionLevel, targetUser } = request;

  const definition = getCapability(capability);
  if (!definition) {
    throw new ValidationError(`Unknown capability: ${capability}`);
  }

  if (!definition.allowedScopes.includes(scopeType)) {
    throw new ValidationError(
      `${capability} cannot be granted at ${scopeType} scope. Allowed: ${definition.allowedScopes.join(', ')}.`,
    );
  }

  if (scopeType !== PermissionScopeType.GLOBAL && !scopeId) {
    throw new ValidationError('A non-global grant requires a scope id.');
  }

  if (actor.user.id && targetUser.id === actor.user.id) {
    throw new SelfManagementError('grant permissions to');
  }

  // The granter must hold permission.grant *for the scope they are granting in*.
  authorize(actor, {
    capability: 'permission.grant',
    scope: scopeToResource(scopeType, scopeId),
    target: { userId: targetUser.id, permissionLevel: targetUser.permissionLevel },
  });

  if (actor.isSystem) return;

  // ...and must hold the capability being granted, in a scope that covers the grant.
  const held = actor.assignments.filter((assignment) => assignment.capabilityKey === capability);
  if (held.length === 0) {
    throw new AuthorizationError(
      `You cannot grant ${capability} because you do not hold it yourself.`,
      { capability },
    );
  }

  const covering = held.filter((assignment) =>
    scopeCovers(assignment, scopeToResource(scopeType, scopeId)),
  );
  if (covering.length === 0) {
    throw new AuthorizationError(
      `You cannot grant ${capability} outside the scope you hold it in.`,
      { capability, scopeType },
    );
  }

  // Ceilings may only ever narrow. `null` on the actor's side means "unlimited within
  // my scope", so only a numeric actor ceiling constrains the grant.
  const bestLevelCeiling = ceilingOf(covering, 'maxPermissionLevel');
  if (typeof maxPermissionLevel === 'number') {
    if (maxPermissionLevel >= actor.user.permissionLevel) {
      throw new AuthorizationError(
        'You cannot grant an authority ceiling at or above your own level.',
        { requested: maxPermissionLevel, actorLevel: actor.user.permissionLevel },
      );
    }
    if (bestLevelCeiling !== null && maxPermissionLevel > bestLevelCeiling) {
      throw new AuthorizationError(
        `You cannot grant an authority ceiling above your own (${bestLevelCeiling}).`,
        { requested: maxPermissionLevel, allowed: bestLevelCeiling },
      );
    }
  } else if (bestLevelCeiling !== null) {
    // Holding the capability is not enough to hand out an unbounded grant when the
    // granter is themselves bounded.
    throw new ValidationError(
      `You must specify an authority ceiling of at most ${bestLevelCeiling}, because your own grant is limited.`,
    );
  }
}

/**
 * Revoking is authorized like granting: same scope, same level ceiling. Without this a
 * guild administrator could strip a global administrator's permissions.
 *
 * @param {import('./evaluate.js').ActorSnapshot} actor
 * @param {{capabilityKey: string, scopeType: string, scopeId: string, user: {id: string, permissionLevel: number}}} assignment
 */
export function assertCanRevoke(actor, assignment) {
  if (actor.user.id && assignment.user.id === actor.user.id) {
    throw new SelfManagementError('revoke permissions from');
  }

  authorize(actor, {
    capability: 'permission.revoke',
    scope: scopeToResource(assignment.scopeType, assignment.scopeId),
    target: { userId: assignment.user.id, permissionLevel: assignment.user.permissionLevel },
  });
}

/** Maps a stored scope tuple onto the resource shape the evaluator expects. */
export function scopeToResource(scopeType, scopeId) {
  return scopeType === PermissionScopeType.GUILD ? { guildId: scopeId } : {};
}

/**
 * The most permissive ceiling across a set of assignments. `null` means at least one
 * assignment is unbounded.
 */
function ceilingOf(assignments, field) {
  let best = null;
  for (const assignment of assignments) {
    const value = assignment[field];
    if (value === null || value === undefined) return null;
    if (best === null || value > best) best = value;
  }
  return best;
}
