/**
 * Reconciliation engine.
 *
 * These tests are the executable form of the specification's rules: desired minus
 * actual equals required changes, unmanaged roles are never touched, roster data beats
 * a manual Discord change, and running twice changes nothing the second time.
 */
import { describe, expect, it } from 'vitest';
import {
  AuthoritySource,
  MappingDirection,
  MembershipStatus,
  RolePurpose,
  SyncActionType,
} from '@frm/shared';
import { computeDesiredState, diffMemberState, summarizePlan } from '@frm/reconciliation';

const G_MAIN = '900000000000000001';
const G_HCSO = '900000000000000002';
const G_FHP = '900000000000000003';

const R_MAIN_HCSO_MEMBER = '800000000000000001';
const R_HCSO_DEPT_MEMBER = '800000000000000002';
const R_HCSO_DEPUTY = '800000000000000003';
const R_HCSO_CORPORAL = '800000000000000004';
const R_HCSO_SUPERVISOR = '800000000000000005';
const R_HCSO_BLET = '800000000000000006';
const R_HCSO_LOA = '800000000000000007';
const R_HCSO_SUSPENDED = '800000000000000008';
const R_MAIN_MEDIA = '800000000000000009';
const R_HCSO_MEDIA = '800000000000000010';
const R_UNMANAGED = '800000000000000099';

const DEPT_HCSO = 'dept-hcso';
const RANK_DEPUTY = 'rank-deputy';
const RANK_CORPORAL = 'rank-corporal';
const CERT_BLET = 'cert-blet';

const GUILDS = [
  { id: 'g1', discordGuildId: G_MAIN, name: 'Main Community' },
  { id: 'g2', discordGuildId: G_HCSO, name: 'HCSO' },
];

const HCSO_DEPARTMENT = {
  id: DEPT_HCSO,
  key: 'hcso',
  name: 'HCSO',
  removeRankRolesOnLoa: false,
  removeRankRolesOnSuspension: true,
  removeMembershipRolesOnSuspension: false,
};

/** The standard managed-role catalogue used by most of these tests. */
function managedRoles() {
  return [
    role(G_MAIN, R_MAIN_HCSO_MEMBER, RolePurpose.DEPARTMENT_MEMBERSHIP, {
      departmentId: DEPT_HCSO,
      name: 'HCSO Member',
    }),
    role(G_HCSO, R_HCSO_DEPT_MEMBER, RolePurpose.DEPARTMENT_MEMBERSHIP, {
      departmentId: DEPT_HCSO,
      name: 'Department Member',
    }),
    role(G_HCSO, R_HCSO_DEPUTY, RolePurpose.RANK, {
      departmentId: DEPT_HCSO,
      rankId: RANK_DEPUTY,
      name: 'Deputy',
    }),
    role(G_HCSO, R_HCSO_CORPORAL, RolePurpose.RANK, {
      departmentId: DEPT_HCSO,
      rankId: RANK_CORPORAL,
      name: 'Corporal',
    }),
    role(G_HCSO, R_HCSO_SUPERVISOR, RolePurpose.SUPERVISOR, {
      departmentId: DEPT_HCSO,
      name: 'Supervisor',
    }),
    role(G_HCSO, R_HCSO_BLET, RolePurpose.CERTIFICATION, {
      departmentId: DEPT_HCSO,
      certificationId: CERT_BLET,
      name: 'BLET Certified',
    }),
    role(G_HCSO, R_HCSO_LOA, RolePurpose.STATUS_LOA, { departmentId: DEPT_HCSO, name: 'On Leave' }),
    role(G_HCSO, R_HCSO_SUSPENDED, RolePurpose.STATUS_SUSPENDED, {
      departmentId: DEPT_HCSO,
      name: 'Suspended',
    }),
  ];
}

function role(discordGuildId, discordRoleId, purpose, extra = {}) {
  return {
    id: `mr-${discordRoleId}`,
    approvedGuildId: discordGuildId === G_MAIN ? 'g1' : 'g2',
    discordGuildId,
    discordRoleId,
    name: extra.name ?? 'Role',
    purpose,
    departmentId: extra.departmentId ?? null,
    rankId: extra.rankId ?? null,
    certificationId: extra.certificationId ?? null,
    subdivisionId: extra.subdivisionId ?? null,
    protectionLevel: 'NONE',
    managedByPlatform: extra.managedByPlatform ?? true,
  };
}

function membership({
  status = MembershipStatus.ACTIVE,
  rankId = RANK_CORPORAL,
  rankName = 'Corporal',
  rankOrder = 20,
  isSupervisor = true,
  isCommand = false,
  department = HCSO_DEPARTMENT,
} = {}) {
  return {
    id: 'membership-1',
    departmentId: department.id,
    departmentKey: department.key,
    departmentName: department.name,
    rankId,
    rankName,
    rankOrder,
    status,
    rank: { id: rankId, name: rankName, order: rankOrder, isSupervisor, isCommand },
    department,
  };
}

function context(overrides = {}) {
  return {
    member: { id: 'user-1', displayName: 'Test Member', discordUserId: '700000000000000001' },
    guilds: GUILDS,
    managedRoles: managedRoles(),
    mappings: [],
    memberships: [membership()],
    certificationIds: [CERT_BLET],
    subdivisionIds: [],
    manualGrantManagedRoleIds: [],
    ...overrides,
  };
}

/** Runs the full pure pipeline and returns the plan. */
function plan(ctx, actual, guilds = GUILDS) {
  const actualByGuild = new Map(
    Object.entries(actual).map(([guildId, roles]) => [
      guildId,
      roles === null ? null : new Set(roles),
    ]),
  );
  const desiredState = computeDesiredState(ctx, actualByGuild);
  return diffMemberState({
    discordUserId: ctx.member.discordUserId,
    desiredState,
    actualByGuild,
    guilds,
  });
}

function actionsOf(result, type) {
  return result.actions
    .filter((action) => action.action === type)
    .map((action) => action.discordRoleId)
    .sort();
}

describe('desired state minus actual state', () => {
  it('produces exactly the specification example', () => {
    // Roster says: HCSO member, Corporal (a supervisor rank), BLET certified.
    // Discord has: department member, Deputy, BLET, plus an unrelated role.
    const result = plan(context(), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_DEPUTY, R_HCSO_BLET, R_UNMANAGED],
    });

    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_HCSO_DEPUTY]);
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual(
      [R_HCSO_CORPORAL, R_HCSO_SUPERVISOR].sort(),
    );
  });

  it('never removes a role the platform does not control', () => {
    const result = plan(context(), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET, R_UNMANAGED],
    });
    expect(result.actions).toHaveLength(0);
  });

  it('is idempotent: a converged state produces no actions', () => {
    const converged = {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET],
    };
    expect(plan(context(), converged).actions).toHaveLength(0);
    expect(plan(context(), converged).actions).toHaveLength(0);
  });

  it('is deterministic: the same input always yields the same ordered plan', () => {
    const state = {
      [G_MAIN]: [],
      [G_HCSO]: [R_HCSO_DEPUTY, R_UNMANAGED],
    };
    const first = plan(context(), state);
    const second = plan(context(), state);
    expect(JSON.stringify(first.actions)).toBe(JSON.stringify(second.actions));
  });

  it('records a reason on every action', () => {
    const result = plan(context(), { [G_MAIN]: [], [G_HCSO]: [] });
    for (const action of result.actions) {
      expect(action.reason).toBeTruthy();
    }
    const corporal = result.actions.find((a) => a.discordRoleId === R_HCSO_CORPORAL);
    expect(corporal.reason).toContain('Corporal');
  });
});

describe('roster authority', () => {
  it('restores the correct rank after a manual Discord change', () => {
    // Somebody manually handed out the Deputy role to a Corporal.
    const result = plan(context(), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [
        R_HCSO_DEPT_MEMBER,
        R_HCSO_CORPORAL,
        R_HCSO_SUPERVISOR,
        R_HCSO_BLET,
        R_HCSO_DEPUTY,
      ],
    });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_HCSO_DEPUTY]);
  });

  it('removes every department role when a membership is terminated', () => {
    const result = plan(context({ memberships: [], certificationIds: [] }), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET, R_UNMANAGED],
    });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual(
      [
        R_MAIN_HCSO_MEMBER,
        R_HCSO_DEPT_MEMBER,
        R_HCSO_CORPORAL,
        R_HCSO_SUPERVISOR,
        R_HCSO_BLET,
      ].sort(),
    );
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([]);
  });

  it('drops a certification role when the certification lapses', () => {
    const result = plan(context({ certificationIds: [] }), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET],
    });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_HCSO_BLET]);
  });
});

describe('status handling', () => {
  it('adds the LOA role and keeps rank roles by default', () => {
    const result = plan(context({ memberships: [membership({ status: MembershipStatus.LOA })] }), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET],
    });
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_LOA]);
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([]);
  });

  it('removes rank roles on LOA when the department is configured that way', () => {
    const department = { ...HCSO_DEPARTMENT, removeRankRolesOnLoa: true };
    const result = plan(
      context({ memberships: [membership({ status: MembershipStatus.LOA, department })] }),
      {
        [G_MAIN]: [R_MAIN_HCSO_MEMBER],
        [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET],
      },
    );
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual(
      [R_HCSO_CORPORAL, R_HCSO_SUPERVISOR].sort(),
    );
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_LOA]);
  });

  it('removes rank roles on suspension but keeps membership by default', () => {
    const result = plan(
      context({ memberships: [membership({ status: MembershipStatus.SUSPENDED })] }),
      {
        [G_MAIN]: [R_MAIN_HCSO_MEMBER],
        [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET],
      },
    );
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_SUSPENDED]);
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual(
      [R_HCSO_CORPORAL, R_HCSO_SUPERVISOR].sort(),
    );
  });

  it('removes membership roles on suspension when configured', () => {
    const department = { ...HCSO_DEPARTMENT, removeMembershipRolesOnSuspension: true };
    const result = plan(
      context({ memberships: [membership({ status: MembershipStatus.SUSPENDED, department })] }),
      {
        [G_MAIN]: [R_MAIN_HCSO_MEMBER],
        [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_BLET],
      },
    );
    const removed = actionsOf(result, SyncActionType.REMOVE_ROLE);
    expect(removed).toContain(R_MAIN_HCSO_MEMBER);
    expect(removed).toContain(R_HCSO_DEPT_MEMBER);
    expect(removed).toContain(R_HCSO_BLET);
  });
});

describe('one-way mappings', () => {
  const mapping = {
    id: 'map-1',
    name: 'Main member -> HCSO guild member',
    sourceGuildId: 'g1',
    sourceDiscordGuildId: G_MAIN,
    sourceRoleId: R_MAIN_MEDIA,
    targetGuildId: 'g2',
    targetDiscordGuildId: G_HCSO,
    targetRoleId: R_HCSO_MEDIA,
    direction: MappingDirection.ONE_WAY,
    authority: AuthoritySource.SOURCE_DISCORD,
    syncAdd: true,
    syncRemove: true,
    priority: 100,
    enabled: true,
  };

  it('adds the target role when the source role is present', () => {
    const result = plan(context({ mappings: [mapping], memberships: [], certificationIds: [] }), {
      [G_MAIN]: [R_MAIN_MEDIA],
      [G_HCSO]: [],
    });
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_MEDIA]);
  });

  it('removes the target role when the source role is gone', () => {
    const result = plan(context({ mappings: [mapping], memberships: [], certificationIds: [] }), {
      [G_MAIN]: [],
      [G_HCSO]: [R_HCSO_MEDIA],
    });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_HCSO_MEDIA]);
  });

  it('does not remove the target role when removal sync is disabled', () => {
    const addOnly = { ...mapping, syncRemove: false };
    const result = plan(context({ mappings: [addOnly], memberships: [], certificationIds: [] }), {
      [G_MAIN]: [],
      [G_HCSO]: [R_HCSO_MEDIA],
    });
    expect(result.actions).toHaveLength(0);
  });

  it('does not add the target role when add sync is disabled', () => {
    const removeOnly = { ...mapping, syncAdd: false };
    const result = plan(
      context({ mappings: [removeOnly], memberships: [], certificationIds: [] }),
      {
        [G_MAIN]: [R_MAIN_MEDIA],
        [G_HCSO]: [],
      },
    );
    expect(result.actions).toHaveLength(0);
  });

  it('never propagates backwards on a one-way mapping', () => {
    const result = plan(context({ mappings: [mapping], memberships: [], certificationIds: [] }), {
      [G_MAIN]: [],
      [G_HCSO]: [R_HCSO_MEDIA],
    });
    // The only action is on the target side; the source is untouched.
    expect(result.actions.every((action) => action.discordGuildId === G_HCSO)).toBe(true);
  });
});

describe('two-way mappings', () => {
  const twoWayUnion = {
    id: 'map-2',
    name: 'Media Team (union)',
    sourceGuildId: 'g1',
    sourceDiscordGuildId: G_MAIN,
    sourceRoleId: R_MAIN_MEDIA,
    targetGuildId: 'g2',
    targetDiscordGuildId: G_HCSO,
    targetRoleId: R_HCSO_MEDIA,
    direction: MappingDirection.TWO_WAY,
    authority: AuthoritySource.MANUAL,
    syncAdd: true,
    syncRemove: true,
    priority: 100,
    enabled: true,
  };

  it('propagates an add in either direction', () => {
    const fromSource = plan(
      context({ mappings: [twoWayUnion], memberships: [], certificationIds: [] }),
      { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [] },
    );
    expect(actionsOf(fromSource, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_MEDIA]);

    const fromTarget = plan(
      context({ mappings: [twoWayUnion], memberships: [], certificationIds: [] }),
      { [G_MAIN]: [], [G_HCSO]: [R_HCSO_MEDIA] },
    );
    expect(actionsOf(fromTarget, SyncActionType.ADD_ROLE)).toEqual([R_MAIN_MEDIA]);
  });

  it('does not flip-flop: union mappings never remove during reconciliation', () => {
    const result = plan(
      context({ mappings: [twoWayUnion], memberships: [], certificationIds: [] }),
      { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [] },
    );
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([]);
  });

  it('lets the authoritative side win when one is configured', () => {
    const sourceWins = { ...twoWayUnion, authority: AuthoritySource.SOURCE_DISCORD };
    const result = plan(
      context({ mappings: [sourceWins], memberships: [], certificationIds: [] }),
      { [G_MAIN]: [], [G_HCSO]: [R_HCSO_MEDIA] },
    );
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_HCSO_MEDIA]);
  });

  it('lets the target side win when target authority is configured', () => {
    const targetWins = { ...twoWayUnion, authority: AuthoritySource.TARGET_DISCORD };
    const result = plan(
      context({ mappings: [targetWins], memberships: [], certificationIds: [] }),
      { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [] },
    );
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_MAIN_MEDIA]);
  });
});

describe('mapping chains', () => {
  it('settles a chain in a single pass', () => {
    const guilds = [...GUILDS, { id: 'g3', discordGuildId: G_FHP, name: 'FHP' }];
    const chainA = {
      id: 'chain-a',
      name: 'A to B',
      sourceGuildId: 'g1',
      sourceDiscordGuildId: G_MAIN,
      sourceRoleId: R_MAIN_MEDIA,
      targetGuildId: 'g2',
      targetDiscordGuildId: G_HCSO,
      targetRoleId: R_HCSO_MEDIA,
      direction: MappingDirection.ONE_WAY,
      authority: AuthoritySource.SOURCE_DISCORD,
      syncAdd: true,
      syncRemove: true,
      priority: 100,
      enabled: true,
    };
    const chainB = {
      ...chainA,
      id: 'chain-b',
      name: 'B to C',
      sourceGuildId: 'g2',
      sourceDiscordGuildId: G_HCSO,
      sourceRoleId: R_HCSO_MEDIA,
      targetGuildId: 'g3',
      targetDiscordGuildId: G_FHP,
      targetRoleId: R_UNMANAGED,
    };

    const ctx = context({
      guilds,
      mappings: [chainA, chainB],
      memberships: [],
      certificationIds: [],
    });
    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [], [G_FHP]: [] }, guilds);

    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_MEDIA, R_UNMANAGED].sort());
  });
});

describe('roster beats mappings', () => {
  it('keeps a roster-required role even when a mapping wants it gone', () => {
    // A mapping claims the department member role should follow a main-guild role the
    // member does not have. Roster data says they are an active member, so it wins.
    const hostileMapping = {
      id: 'map-3',
      name: 'Would remove department membership',
      sourceGuildId: 'g1',
      sourceDiscordGuildId: G_MAIN,
      sourceRoleId: R_MAIN_MEDIA,
      targetGuildId: 'g2',
      targetDiscordGuildId: G_HCSO,
      targetRoleId: R_HCSO_DEPT_MEMBER,
      direction: MappingDirection.ONE_WAY,
      authority: AuthoritySource.SOURCE_DISCORD,
      syncAdd: true,
      syncRemove: true,
      priority: 100,
      enabled: true,
    };

    const result = plan(context({ mappings: [hostileMapping] }), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET],
    });

    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([]);
    expect(result.conflicts.some((c) => c.type === 'MAPPING_OVERRIDDEN_BY_ROSTER')).toBe(true);
  });
});

describe('members missing from a guild', () => {
  it('reports a warning instead of planning impossible actions', () => {
    const result = plan(context(), {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: null,
    });
    expect(result.actions.every((action) => action.discordGuildId === G_MAIN)).toBe(true);
    expect(result.guildsMissingMember).toEqual([G_HCSO]);
    expect(result.warnings.some((w) => w.type === 'MEMBER_NOT_IN_GUILD')).toBe(true);
  });
});

describe('manual grants', () => {
  const manualRole = role(G_HCSO, R_UNMANAGED, RolePurpose.MANUAL_GRANT, {
    name: 'Investigation Access',
  });

  it('grants a manual role while the grant is active', () => {
    const ctx = context({
      managedRoles: [...managedRoles(), manualRole],
      manualGrantManagedRoleIds: [manualRole.id],
    });
    const result = plan(ctx, {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET],
    });
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_UNMANAGED]);
  });

  it('removes a manual role once the grant has expired or been revoked', () => {
    const ctx = context({
      managedRoles: [...managedRoles(), manualRole],
      manualGrantManagedRoleIds: [],
    });
    const result = plan(ctx, {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET, R_UNMANAGED],
    });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_UNMANAGED]);
  });
});

describe('hands-off roles', () => {
  it('never touches a role marked as not platform managed', () => {
    const handsOff = role(G_HCSO, R_UNMANAGED, RolePurpose.RANK, {
      departmentId: DEPT_HCSO,
      rankId: RANK_DEPUTY,
      managedByPlatform: false,
    });
    const ctx = context({ managedRoles: [...managedRoles(), handsOff] });
    const result = plan(ctx, {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET, R_UNMANAGED],
    });
    expect(result.actions).toHaveLength(0);
  });

  it('never treats a role of purpose OTHER as removable', () => {
    const other = role(G_HCSO, R_UNMANAGED, RolePurpose.OTHER, { name: 'Community Events' });
    const ctx = context({ managedRoles: [...managedRoles(), other] });
    const result = plan(ctx, {
      [G_MAIN]: [R_MAIN_HCSO_MEMBER],
      [G_HCSO]: [R_HCSO_DEPT_MEMBER, R_HCSO_CORPORAL, R_HCSO_SUPERVISOR, R_HCSO_BLET, R_UNMANAGED],
    });
    expect(result.actions).toHaveLength(0);
  });
});

describe('plan summary', () => {
  it('counts adds, removes and conflicts for previews', () => {
    const result = plan(context(), {
      [G_MAIN]: [],
      [G_HCSO]: [R_HCSO_DEPUTY],
    });
    const summary = summarizePlan(result);
    expect(summary.addCount).toBeGreaterThan(0);
    expect(summary.removeCount).toBe(1);
    expect(summary.totalActions).toBe(summary.addCount + summary.removeCount);
  });
});
