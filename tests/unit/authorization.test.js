/**
 * Authorization rules.
 *
 * The shape of authority here is capability + scope (global or guild) + authority
 * level. A guild-scoped administrator must be able to run their own guild and nothing
 * else, and must never be able to hand out more than they hold.
 */
import { describe, expect, it } from 'vitest';
import {
  DenialReason,
  assertCanGrant,
  authorize,
  evaluate,
  guildScopeFilter,
  hasCapabilityAnywhere,
} from '@frm/authorization';
import { PermissionLevel, PermissionScopeType, UserStatus } from '@frm/shared';

const HCSO_GUILD = 'guild-hcso';
const FHP_GUILD = 'guild-fhp';

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

/** Builds an actor snapshot without touching the database. */
function actor({
  id = 'user-guild-admin',
  level = PermissionLevel.STAFF,
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

function assignment(overrides = {}) {
  return {
    id: 'assignment-1',
    capabilityKey: 'mapping.create',
    scopeType: PermissionScopeType.GUILD,
    scopeId: HCSO_GUILD,
    maxPermissionLevel: PermissionLevel.COMMAND,
    ...overrides,
  };
}

const guildAdmin = actor({ assignments: [assignment()] });

describe('capability and scope', () => {
  it('allows an action inside the granted guild', () => {
    const decision = evaluate(guildAdmin, {
      capability: 'mapping.create',
      scope: { guildId: HCSO_GUILD },
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies the same action in a different guild', () => {
    const decision = evaluate(guildAdmin, {
      capability: 'mapping.create',
      scope: { guildId: FHP_GUILD },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.OUT_OF_SCOPE);
  });

  it('denies a guild-scoped holder an action with no guild context', () => {
    // Nothing identifies which guild this is about, so a guild-scoped grant cannot
    // cover it. Only a global holder may act here.
    const decision = evaluate(guildAdmin, { capability: 'mapping.create', scope: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.OUT_OF_SCOPE);
  });

  it('denies a capability the actor does not hold at all', () => {
    const decision = evaluate(guildAdmin, { capability: 'guild.register', scope: {} });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.MISSING_CAPABILITY);
  });

  it('treats a grant stored at an unsupported scope type as invalid, not as a wildcard', () => {
    // guild.register is GLOBAL-only; a GUILD-scoped row must not authorize it.
    const rogue = actor({
      level: PermissionLevel.GLOBAL_ADMIN,
      assignments: [assignment({ capabilityKey: 'guild.register' })],
    });
    const decision = evaluate(rogue, {
      capability: 'guild.register',
      scope: { guildId: HCSO_GUILD },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.OUT_OF_SCOPE);
  });

  it('honours a global assignment for every guild', () => {
    const admin = actor({
      level: PermissionLevel.GLOBAL_ADMIN,
      assignments: [
        assignment({
          scopeType: PermissionScopeType.GLOBAL,
          scopeId: '',
          maxPermissionLevel: null,
        }),
      ],
    });
    expect(
      evaluate(admin, { capability: 'mapping.create', scope: { guildId: FHP_GUILD } }).allowed,
    ).toBe(true);
    expect(evaluate(admin, { capability: 'mapping.create', scope: {} }).allowed).toBe(true);
  });
});

describe('authority level enforcement', () => {
  it('denies acting on a peer or superior', () => {
    const decision = evaluate(guildAdmin, {
      capability: 'mapping.create',
      scope: { guildId: HCSO_GUILD },
      target: { userId: 'user-admin', permissionLevel: PermissionLevel.GLOBAL_ADMIN },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.LEVEL_CEILING);
  });

  it('denies a target above the assignment authority ceiling', () => {
    const decision = evaluate(guildAdmin, {
      capability: 'mapping.create',
      scope: { guildId: HCSO_GUILD },
      // Below the actor's own level, but above the ceiling on their grant.
      target: { userId: 'user-manager', permissionLevel: PermissionLevel.MANAGER },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.LEVEL_CEILING);
  });

  it('denies an actor whose level is below the capability minimum', () => {
    const junior = actor({ level: PermissionLevel.MEMBER, assignments: [assignment()] });
    const decision = evaluate(junior, {
      capability: 'mapping.create',
      scope: { guildId: HCSO_GUILD },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.LEVEL_TOO_LOW);
  });
});

describe('self management', () => {
  it('refuses to let an actor act on their own record', () => {
    const decision = evaluate(guildAdmin, {
      capability: 'grant.issue',
      scope: { guildId: HCSO_GUILD },
      target: { userId: guildAdmin.user.id },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.SELF_MANAGEMENT);
  });

  it('allows explicitly self-safe actions', () => {
    const decision = evaluate(guildAdmin, {
      capability: 'member.view',
      scope: { guildId: HCSO_GUILD },
      target: { userId: guildAdmin.user.id },
      allowSelf: true,
    });
    // member.view is not granted to this actor, so it still fails - but on capability,
    // not on the self-management rule.
    expect(decision.reason).toBe(DenialReason.MISSING_CAPABILITY);
  });
});

describe('account state', () => {
  it('denies a disabled account regardless of grants', () => {
    const disabled = actor({ status: UserStatus.DISABLED, assignments: [assignment()] });
    const decision = evaluate(disabled, {
      capability: 'mapping.create',
      scope: { guildId: HCSO_GUILD },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DenialReason.INACTIVE_ACCOUNT);
  });
});

describe('authorize()', () => {
  it('throws a readable error when out of scope', () => {
    const error = thrownBy(() =>
      authorize(guildAdmin, { capability: 'mapping.create', scope: { guildId: FHP_GUILD } }),
    );
    expect(error.code).toBe('FORBIDDEN');
    expect(error.userMessage).toMatch(/do not have mapping.create/i);
  });

  it('throws a self-management error when acting on self', () => {
    const error = thrownBy(() =>
      authorize(guildAdmin, {
        capability: 'mapping.create',
        scope: { guildId: HCSO_GUILD },
        target: { userId: guildAdmin.user.id },
      }),
    );
    expect(error.code).toBe('SELF_MANAGEMENT');
    expect(error.userMessage).toMatch(/yourself/i);
  });
});

describe('scope filters for list queries', () => {
  it('returns the guild ids an actor may see', () => {
    expect(guildScopeFilter(guildAdmin, 'mapping.create')).toEqual([HCSO_GUILD]);
  });

  it('returns null (meaning unrestricted) for a global holder', () => {
    const admin = actor({
      assignments: [assignment({ scopeType: PermissionScopeType.GLOBAL, scopeId: '' })],
    });
    expect(guildScopeFilter(admin, 'mapping.create')).toBeNull();
  });

  it('reports capability presence for UI affordances only', () => {
    expect(hasCapabilityAnywhere(guildAdmin, 'mapping.create')).toBe(true);
    expect(hasCapabilityAnywhere(guildAdmin, 'guild.register')).toBe(false);
  });
});

describe('privilege escalation through grants', () => {
  const granter = actor({
    id: 'user-manager',
    level: PermissionLevel.MANAGER,
    assignments: [
      assignment({
        capabilityKey: 'permission.grant',
        maxPermissionLevel: PermissionLevel.COMMAND,
      }),
      assignment({ capabilityKey: 'grant.issue', maxPermissionLevel: PermissionLevel.COMMAND }),
    ],
  });
  const target = { id: 'user-target', permissionLevel: PermissionLevel.SUPERVISOR };

  it('allows granting a narrower version of a capability the actor holds', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'grant.issue',
        scopeType: PermissionScopeType.GUILD,
        scopeId: HCSO_GUILD,
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

  it('refuses to grant outside the actor scope', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'grant.issue',
        scopeType: PermissionScopeType.GUILD,
        scopeId: FHP_GUILD,
        maxPermissionLevel: PermissionLevel.SUPERVISOR,
        targetUser: target,
      }),
    ).toThrowError();
  });

  it('refuses to grant authority at or above the actor own level', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'grant.issue',
        scopeType: PermissionScopeType.GUILD,
        scopeId: HCSO_GUILD,
        maxPermissionLevel: PermissionLevel.MANAGER,
        targetUser: target,
      }),
    ).toThrowError(/at or above your own level/i);
  });

  it('refuses to grant an unbounded ceiling when the actor is bounded', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'grant.issue',
        scopeType: PermissionScopeType.GUILD,
        scopeId: HCSO_GUILD,
        targetUser: target,
      }),
    ).toThrowError(/authority ceiling of at most/i);
  });

  it('refuses a self grant', () => {
    const error = thrownBy(() =>
      assertCanGrant(granter, {
        capability: 'grant.issue',
        scopeType: PermissionScopeType.GUILD,
        scopeId: HCSO_GUILD,
        maxPermissionLevel: PermissionLevel.SUPERVISOR,
        targetUser: { id: granter.user.id, permissionLevel: PermissionLevel.MANAGER },
      }),
    );
    expect(error.code).toBe('SELF_MANAGEMENT');
    expect(error.userMessage).toMatch(/yourself/i);
  });

  it('refuses to re-permission somebody at or above the actor level', () => {
    expect(() =>
      assertCanGrant(granter, {
        capability: 'grant.issue',
        scopeType: PermissionScopeType.GUILD,
        scopeId: HCSO_GUILD,
        maxPermissionLevel: PermissionLevel.SUPERVISOR,
        targetUser: { id: 'user-peer', permissionLevel: PermissionLevel.MANAGER },
      }),
    ).toThrowError();
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
