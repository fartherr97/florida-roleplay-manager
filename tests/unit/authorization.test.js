/**
 * Authorization rules.
 *
 * These encode the worked example from the specification: a Sheriff with
 * department-scoped promote authority up to Major must be able to promote their own
 * deputies and nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  DenialReason,
  assertCanGrant,
  authorize,
  departmentScopeFilter,
  evaluate,
  hasCapabilityAnywhere,
} from '@frm/authorization';
import { PermissionLevel, PermissionScopeType, UserStatus } from '@frm/shared';

const HCSO = 'dep-hcso';
const FHP = 'dep-fhp';
const HCSO_GUILD = 'guild-hcso';

/** Builds an actor snapshot without touching the database. */
function actor({
  id = 'user-sheriff',
  level = PermissionLevel.DEPARTMENT_HEAD,
  status = UserStatus.ACTIVE,
  assignments = [],
} = {}) {
  return {
    user: { id, displayName: 'Test Actor', status, permissionLevel: level },
    discordUserId: '100000000000000001',
    assignments,
    isSystem: false,
  };
}

/**
 * Captures a thrown AppError so assertions can target `userMessage` - the text a
 * member actually sees - rather than the internal message kept for logs.
 */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw, but it did not');
}

function assignment(overrides = {}) {
  return {
    id: 'assignment-1',
    capabilityKey: 'roster.promote',
    scopeType: PermissionScopeType.DEPARTMENT,
    scopeId: HCSO,
    maxRankOrder: 60, // Major
    maxPermissionLevel: PermissionLevel.COMMAND,
    ...overrides,
  };
}

const sheriff = actor({ assignments: [assignment()] });

describe('capability and scope', () => {
  it('allows a promotion inside the department and under the rank ceiling', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: {
        userId: 'user-deputy',
        permissionLevel: 0,
        currentRankOrder: 10,
        resultingRankOrder: 20,
      },
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies the same promotion in a different department', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: FHP },
      target: {
        userId: 'user-trooper',
        permissionLevel: 0,
        currentRankOrder: 10,
        resultingRankOrder: 20,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.OUT_OF_SCOPE);
  });

  it('denies a capability the actor does not hold at all', () => {
    const decision = evaluate(sheriff, {
      capability: 'guild.register',
      scope: {},
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.MISSING_CAPABILITY);
  });

  it('treats a grant stored at an unsupported scope type as invalid, not as a wildcard', () => {
    // guild.register is GLOBAL-only; a DEPARTMENT-scoped row must not authorize it.
    const rogue = actor({
      level: PermissionLevel.GLOBAL_ADMIN,
      assignments: [
        assignment({
          capabilityKey: 'guild.register',
          scopeType: PermissionScopeType.DEPARTMENT,
          scopeId: HCSO,
        }),
      ],
    });
    const decision = evaluate(rogue, {
      capability: 'guild.register',
      scope: { departmentId: HCSO },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.OUT_OF_SCOPE);
  });

  it('honours a global assignment for every scope', () => {
    const admin = actor({
      level: PermissionLevel.GLOBAL_ADMIN,
      assignments: [
        assignment({
          capabilityKey: 'roster.promote',
          scopeType: PermissionScopeType.GLOBAL,
          scopeId: '',
          maxRankOrder: null,
          maxPermissionLevel: null,
        }),
      ],
    });
    const decision = evaluate(admin, {
      capability: 'roster.promote',
      scope: { departmentId: FHP },
      target: {
        userId: 'anyone',
        permissionLevel: 0,
        currentRankOrder: 70,
        resultingRankOrder: 80,
      },
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('rank hierarchy enforcement', () => {
  it('denies promoting to a rank above the ceiling', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: {
        userId: 'user-captain',
        permissionLevel: 0,
        currentRankOrder: 50,
        resultingRankOrder: 70,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.RANK_CEILING);
  });

  it('denies acting on somebody whose current rank is already above the ceiling', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: {
        userId: 'user-colonel',
        permissionLevel: 0,
        currentRankOrder: 70,
        resultingRankOrder: 20,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.RANK_CEILING);
  });

  it('allows a promotion exactly at the ceiling', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: {
        userId: 'user-captain',
        permissionLevel: 0,
        currentRankOrder: 50,
        resultingRankOrder: 60,
      },
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('authority level enforcement', () => {
  it('denies acting on a peer or superior', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: {
        userId: 'user-admin',
        permissionLevel: PermissionLevel.GLOBAL_ADMIN,
        currentRankOrder: 10,
        resultingRankOrder: 20,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.LEVEL_CEILING);
  });

  it('denies a target above the assignment authority ceiling', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: {
        userId: 'user-staff',
        permissionLevel: PermissionLevel.STAFF - 20, // below the actor, above the ceiling
        currentRankOrder: 10,
        resultingRankOrder: 20,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.LEVEL_CEILING);
  });

  it('denies an actor whose level is below the capability minimum', () => {
    const junior = actor({
      level: PermissionLevel.MEMBER,
      assignments: [assignment()],
    });
    const decision = evaluate(junior, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: { userId: 'x', permissionLevel: 0, currentRankOrder: 10, resultingRankOrder: 20 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.LEVEL_TOO_LOW);
  });
});

describe('self management', () => {
  it('refuses to let an actor promote themselves', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: {
        userId: sheriff.user.id,
        permissionLevel: 0,
        currentRankOrder: 10,
        resultingRankOrder: 20,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.SELF_MANAGEMENT);
  });

  it('allows explicitly self-safe actions', () => {
    const decision = evaluate(sheriff, {
      capability: 'roster.view',
      scope: { departmentId: HCSO },
      target: { userId: sheriff.user.id },
      allowSelf: true,
    });
    // roster.view is not granted to this actor, so it still fails - but on capability,
    // not on the self-management rule.
    expect(decision.reason).toBe(DenialReason.MISSING_CAPABILITY);
  });
});

describe('account state', () => {
  it('denies a disabled account regardless of grants', () => {
    const disabled = actor({ status: UserStatus.DISABLED, assignments: [assignment()] });
    const decision = evaluate(disabled, {
      capability: 'roster.promote',
      scope: { departmentId: HCSO },
      target: { userId: 'other', permissionLevel: 0, currentRankOrder: 10, resultingRankOrder: 20 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.INACTIVE_ACCOUNT);
  });
});

describe('authorize()', () => {
  it('throws a typed error on rank ceiling failures', () => {
    expect(() =>
      authorize(sheriff, {
        capability: 'roster.promote',
        scope: { departmentId: HCSO },
        target: { userId: 'u', permissionLevel: 0, currentRankOrder: 10, resultingRankOrder: 90 },
      }),
    ).toThrowError(/above the maximum rank/i);
  });

  it('throws a self-management error when acting on self', () => {
    const error = thrownBy(() =>
      authorize(sheriff, {
        capability: 'roster.promote',
        scope: { departmentId: HCSO },
        target: { userId: sheriff.user.id },
      }),
    );
    expect(error.code).toBe('SELF_MANAGEMENT');
    expect(error.userMessage).toMatch(/yourself/i);
  });
});

describe('scope filters for list queries', () => {
  it('returns the department ids an actor may see', () => {
    expect(departmentScopeFilter(sheriff, 'roster.promote')).toEqual([HCSO]);
  });

  it('returns null (meaning unrestricted) for a global holder', () => {
    const admin = actor({
      assignments: [assignment({ scopeType: PermissionScopeType.GLOBAL, scopeId: '' })],
    });
    expect(departmentScopeFilter(admin, 'roster.promote')).toBeNull();
  });

  it('reports capability presence for UI affordances only', () => {
    expect(hasCapabilityAnywhere(sheriff, 'roster.promote')).toBe(true);
    expect(hasCapabilityAnywhere(sheriff, 'guild.register')).toBe(false);
  });
});

describe('privilege escalation through grants', () => {
  const granter = actor({
    id: 'user-head',
    level: PermissionLevel.DEPARTMENT_HEAD,
    assignments: [
      assignment({
        capabilityKey: 'permission.grant',
        maxRankOrder: 60,
        maxPermissionLevel: PermissionLevel.COMMAND,
      }),
      assignment({
        capabilityKey: 'roster.promote',
        maxRankOrder: 60,
        maxPermissionLevel: PermissionLevel.COMMAND,
      }),
    ],
  });
  const target = { id: 'user-lieutenant', permissionLevel: PermissionLevel.SUPERVISOR };

  it('allows granting a narrower version of a capability the actor holds', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: HCSO,
        maxRankOrder: 30,
        maxPermissionLevel: PermissionLevel.SUPERVISOR,
        targetUser: target,
      }),
    ).not.toThrow();
  });

  it('refuses to grant a capability the actor does not hold', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'guild.register',
        scopeType: PermissionScopeType.GLOBAL,
        scopeId: '',
        targetUser: target,
      }),
    ).toThrowError();
  });

  it('refuses to grant a rank ceiling above the actor own ceiling', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: HCSO,
        maxRankOrder: 80,
        maxPermissionLevel: PermissionLevel.SUPERVISOR,
        targetUser: target,
      }),
    ).toThrowError(/rank ceiling above your own/i);
  });

  it('refuses to grant an unbounded ceiling when the actor is bounded', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: HCSO,
        maxPermissionLevel: PermissionLevel.SUPERVISOR,
        targetUser: target,
      }),
    ).toThrowError(/rank ceiling of at most/i);
  });

  it('refuses to grant authority at or above the actor own level', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: HCSO,
        maxRankOrder: 30,
        maxPermissionLevel: PermissionLevel.DEPARTMENT_HEAD,
        targetUser: target,
      }),
    ).toThrowError(/at or above your own level/i);
  });

  it('refuses to grant outside the actor scope', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: FHP,
        maxRankOrder: 30,
        maxPermissionLevel: PermissionLevel.SUPERVISOR,
        targetUser: target,
      }),
    ).toThrowError();
  });

  it('refuses a self grant', () => {
    const error = thrownBy(() =>
      assertCanGrant(granter, {
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: HCSO,
        maxRankOrder: 30,
        targetUser: { id: granter.user.id, permissionLevel: PermissionLevel.DEPARTMENT_HEAD },
      }),
    );
    expect(error.code).toBe('SELF_MANAGEMENT');
    expect(error.userMessage).toMatch(/yourself/i);
  });

  it('refuses to re-permission somebody at or above the actor level', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: HCSO,
        maxRankOrder: 30,
        targetUser: { id: 'user-peer', permissionLevel: PermissionLevel.DEPARTMENT_HEAD },
      }),
    ).toThrowError();
  });

  it('guild scope filter is unaffected by department grants', () => {
    expect(departmentScopeFilter(granter, 'permission.grant')).toEqual([HCSO]);
  });
});

describe('system actor', () => {
  it('is allowed, and is never derived from user input', () => {
    const system = {
      user: { id: null, permissionLevel: 100, status: 'ACTIVE' },
      assignments: [],
      isSystem: true,
    };
    expect(evaluate(system, { capability: 'sync.global' }).allowed).toBe(true);
  });
});

describe('guild scope', () => {
  it('matches a guild-scoped assignment against the resource guild', () => {
    const guildAdmin = actor({
      level: PermissionLevel.STAFF,
      assignments: [
        assignment({
          capabilityKey: 'mapping.create',
          scopeType: PermissionScopeType.GUILD,
          scopeId: HCSO_GUILD,
          maxRankOrder: null,
        }),
      ],
    });
    expect(
      evaluate(guildAdmin, { capability: 'mapping.create', scope: { guildId: HCSO_GUILD } })
        .allowed,
    ).toBe(true);
    expect(
      evaluate(guildAdmin, { capability: 'mapping.create', scope: { guildId: 'guild-other' } })
        .allowed,
    ).toBe(false);
  });
});
