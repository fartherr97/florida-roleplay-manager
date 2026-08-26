/**
 * Discord-role access tiers - the resolution core.
 *
 * These are the pure parts that decide access: the tier a member's roles confer, the
 * capabilities a tier synthesizes, and the actor it produces. They are checked end to end
 * against the real authorization evaluator, so "holding this role lets me run this command"
 * is proven without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  augmentActorWithTier,
  resolveDiscordActor,
  resolveTierAccess,
  resolveTierLevel,
  synthesizeAccessAssignments,
  synthesizeAssignmentsFromCapabilities,
  tierLevelOf,
} from '@frm/core';
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

describe('named tiers (capability sets)', () => {
  const TIER_ID = 'tier-whitelist';
  const tierDefs = new Map([
    // A tier that can approve whitelist submissions (member.link, minLevel STAFF=80) and look
    // members up (member.view, minLevel MEMBER=0). access.manage is never allowed in.
    [TIER_ID, { capabilities: ['member.link', 'member.view', 'access.manage'] }],
  ]);
  const namedRules = [{ discordRoleId: 'wl', accessTierId: TIER_ID }];

  it('tierLevelOf takes the highest minimum level among the capabilities', () => {
    expect(tierLevelOf(['member.view'])).toBe(0);
    expect(tierLevelOf(['member.view', 'member.link'])).toBe(80); // member.link is STAFF
    expect(tierLevelOf([])).toBe(0);
  });

  it('resolves exactly the tier capabilities, dropping the excluded ones', () => {
    const { level, capabilities } = resolveTierAccess(namedRules, ['wl'], tierDefs);
    expect(capabilities.has('member.link')).toBe(true);
    expect(capabilities.has('member.view')).toBe(true);
    expect(capabilities.has('access.manage')).toBe(false); // withheld even when listed
    expect(level).toBe(80); // implied by member.link
  });

  it('is empty when the held role maps to no tier', () => {
    const { level, capabilities } = resolveTierAccess(namedRules, ['other'], tierDefs);
    expect(level).toBe(0);
    expect(capabilities.size).toBe(0);
  });

  it('unions named and legacy mappings, taking the highest level', () => {
    const rules = [
      { discordRoleId: 'wl', accessTierId: TIER_ID }, // member.link/view, level 80
      { discordRoleId: 'supervisor', permissionLevel: 20 }, // everything up to 20
    ];
    const { level, capabilities } = resolveTierAccess(rules, ['wl', 'supervisor'], tierDefs);
    expect(level).toBe(80);
    expect(capabilities.has('member.link')).toBe(true); // from the named tier
    expect(capabilities.has('sync.member')).toBe(true); // from the level-20 legacy mapping
  });

  it('grants only the listed capabilities through the real evaluator', () => {
    const { level, capabilities } = resolveTierAccess(namedRules, ['wl'], tierDefs);
    const actor = augmentActorWithTier(baseActor(), { level, capabilities });

    // Possesses member.link and clears its STAFF minimum.
    expect(evaluate(actor, { capability: 'member.link', scope: {} }).allowed).toBe(true);
    // Level is 80, but it never possesses mapping.create, so it cannot run it - least privilege.
    expect(evaluate(actor, { capability: 'mapping.create', scope: {} }).allowed).toBe(false);
    // access.manage is never grantable by a tier.
    expect(evaluate(actor, { capability: 'access.manage', scope: {} }).allowed).toBe(false);
  });

  it('synthesizes GLOBAL, uncapped assignments from a capability set', () => {
    const assignments = synthesizeAssignmentsFromCapabilities(new Set(['member.link', 'access.manage']));
    expect(assignments.map((a) => a.capabilityKey)).toEqual(['member.link']); // excluded key dropped
    expect(assignments.every((a) => a.scopeType === 'GLOBAL' && a.maxPermissionLevel === null)).toBe(
      true,
    );
  });
});

describe('resolveDiscordActor resilience', () => {
  // The tier lookup runs in the command guard for every command. If it cannot read the
  // access-tier table - most importantly before the migration is applied in production - it
  // must degrade to "no tier", never take the whole bot down with an unexpected failure.
  it('degrades to the base actor when the access-tier table cannot be read', async () => {
    const user = {
      id: '11111111-1111-1111-1111-111111111111',
      displayName: 'Admin',
      status: 'ACTIVE',
      permissionLevel: 40,
      websiteAccess: false,
      primaryDiscordId: 'd1',
      discordIdentities: [{ discordUserId: 'd1' }],
    };
    const prisma = {
      approvedGuild: {
        findFirst: async () => ({ id: 'g', discordGuildId: '910000000000000001' }),
      },
      roleAccessTier: {
        findMany: async () => {
          throw new Error('relation "role_access_tiers" does not exist');
        },
      },
      user: { findFirst: async () => user },
      permissionAssignment: { findMany: async () => [] },
    };
    const gateway = { getMember: async () => ({ id: 'd1', roleIds: [] }) };

    const actor = await resolveDiscordActor({ discordUserId: 'd1', gateway, prisma });
    expect(actor).not.toBeNull();
    expect(actor.user.permissionLevel).toBe(40); // base level; tier resolution failed gracefully
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
