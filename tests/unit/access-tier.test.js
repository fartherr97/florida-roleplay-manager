/**
 * Discord-role access tiers - the resolution core.
 *
 * These are the pure parts that decide access: the tier a member's roles confer, the
 * capabilities a tier synthesizes, and the actor it produces. They are checked end to end
 * against the real authorization evaluator, so "holding this role lets me run this command"
 * is proven without a database.
 */
import { describe, expect, it } from 'vitest';
import { augmentActorWithTier, resolveTierLevel, synthesizeAccessAssignments } from '@frm/core';
import { evaluate } from '@frm/authorization';

const RULES = [
  { discordRoleId: 'staff', permissionLevel: 80 },
  { discordRoleId: 'supervisor', permissionLevel: 20 },
];

const baseActor = () => ({
  user: { id: 'u1', displayName: 'Tester', status: 'ACTIVE', permissionLevel: 0 },
  discordUserId: 'd1',
  assignments: [],
  isSystem: false,
});

const keys = (assignments) => new Set(assignments.map((a) => a.capabilityKey));

describe('resolveTierLevel', () => {
  it('takes the highest tier among the roles held', () => {
    expect(resolveTierLevel(RULES, ['staff', 'supervisor'])).toBe(80);
    expect(resolveTierLevel(RULES, ['supervisor'])).toBe(20);
  });

  it('is zero when no held role is mapped', () => {
    expect(resolveTierLevel(RULES, ['random'])).toBe(0);
    expect(resolveTierLevel(RULES, [])).toBe(0);
  });
});

describe('synthesizeAccessAssignments', () => {
  it('grants every capability up to the tier, all GLOBAL and uncapped', () => {
    const assignments = synthesizeAccessAssignments(80);
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((a) => a.scopeType === 'GLOBAL' && a.scopeId === '')).toBe(true);
    expect(assignments.every((a) => a.maxPermissionLevel === null)).toBe(true);

    const granted = keys(assignments);
    expect(granted.has('mapping.create')).toBe(true); // minLevel 80
    expect(granted.has('member.view')).toBe(true); // minLevel 0
    expect(granted.has('sync.global')).toBe(false); // minLevel 100, above the tier
  });

  it('never grants access.manage, even at the top tier', () => {
    const top = keys(synthesizeAccessAssignments(100));
    expect(top.has('system.manage')).toBe(true);
    expect(top.has('guild.register')).toBe(true);
    expect(top.has('access.manage')).toBe(false); // control over the mapping itself is withheld
  });

  it('grants nothing at tier zero', () => {
    expect(synthesizeAccessAssignments(0)).toEqual([]);
  });
});

describe('augmentActorWithTier', () => {
  it('raises the authority level and appends the assignments', () => {
    const augmented = augmentActorWithTier(baseActor(), 80);
    expect(augmented.user.permissionLevel).toBe(80);
    expect(keys(augmented.assignments).has('mapping.create')).toBe(true);
  });

  it('returns the actor unchanged at tier zero', () => {
    const actor = baseActor();
    expect(augmentActorWithTier(actor, 0)).toBe(actor);
  });

  it('never lowers an existing higher authority level', () => {
    const actor = { ...baseActor(), user: { ...baseActor().user, permissionLevel: 100 } };
    expect(augmentActorWithTier(actor, 40).user.permissionLevel).toBe(100);
  });
});

describe('tier access through the real evaluator', () => {
  it('lets a Staff-tier actor run a Staff command but not a global-admin one', () => {
    const staff = augmentActorWithTier(baseActor(), 80);

    expect(evaluate(staff, { capability: 'mapping.create', scope: {} }).allowed).toBe(true);
    expect(evaluate(staff, { capability: 'sync.global', scope: {} }).allowed).toBe(false);
  });

  it('never lets even a top-tier actor manage the access mapping itself', () => {
    const admin = augmentActorWithTier(baseActor(), 100);

    expect(evaluate(admin, { capability: 'system.manage', scope: {} }).allowed).toBe(true);
    expect(evaluate(admin, { capability: 'access.manage', scope: {} }).allowed).toBe(false);
  });

  it('respects the authority ceiling at the tier level', () => {
    const staff = augmentActorWithTier(baseActor(), 80);
    // Can act on someone below the tier, not on someone at or above it.
    expect(
      evaluate(staff, {
        capability: 'permission.grant',
        scope: {},
        target: { userId: 'other', permissionLevel: 40 },
      }).allowed,
    ).toBe(true);
    expect(
      evaluate(staff, {
        capability: 'permission.grant',
        scope: {},
        target: { userId: 'other', permissionLevel: 80 },
      }).allowed,
    ).toBe(false);
  });
});
