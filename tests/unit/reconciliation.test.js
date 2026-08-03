/**
 * Reconciliation engine.
 *
 * These tests are the executable form of the platform's rules: desired minus actual
 * equals required changes, unmanaged roles are never touched, mappings and grants are
 * the only sources of desired state, and running twice changes nothing the second time.
 */
import { describe, expect, it } from 'vitest';
import { AuthoritySource, MappingDirection, RolePurpose, SyncActionType } from '@frm/shared';
import { computeDesiredState, diffMemberState, summarizePlan } from '@frm/reconciliation';

const G_MAIN = '900000000000000001';
const G_HCSO = '900000000000000002';
const G_FHP = '900000000000000003';

const R_MAIN_MEMBER = '800000000000000001';
const R_HCSO_MEMBER = '800000000000000002';
const R_MAIN_MEDIA = '800000000000000009';
const R_HCSO_MEDIA = '800000000000000010';
const R_GRANTABLE = '800000000000000020';
const R_CHAIN_END = '800000000000000030';
const R_UNMANAGED = '800000000000000099';

const GUILDS = [
  { id: 'g1', discordGuildId: G_MAIN, name: 'Main Community' },
  { id: 'g2', discordGuildId: G_HCSO, name: 'HCSO' },
];

function role(discordGuildId, discordRoleId, purpose = RolePurpose.MAPPING, extra = {}) {
  return {
    id: `mr-${discordRoleId}`,
    approvedGuildId: discordGuildId === G_MAIN ? 'g1' : 'g2',
    discordGuildId,
    discordRoleId,
    name: extra.name ?? `Role ${discordRoleId}`,
    purpose,
    protectionLevel: 'NONE',
    managedByPlatform: extra.managedByPlatform ?? true,
  };
}

/** The standard managed-role catalogue used by most of these tests. */
function managedRoles() {
  return [
    role(G_MAIN, R_MAIN_MEMBER, RolePurpose.MAPPING, { name: 'HCSO Member' }),
    role(G_HCSO, R_HCSO_MEMBER, RolePurpose.MAPPING, { name: 'Department Member' }),
    role(G_MAIN, R_MAIN_MEDIA, RolePurpose.MAPPING, { name: 'Media Team' }),
    role(G_HCSO, R_HCSO_MEDIA, RolePurpose.MAPPING, { name: 'Media Team' }),
    role(G_HCSO, R_GRANTABLE, RolePurpose.MANUAL_GRANT, { name: 'Investigation Access' }),
  ];
}

function mapping(overrides = {}) {
  return {
    id: 'map-1',
    name: 'HCSO Member -> Department Member',
    sourceGuildId: 'g1',
    sourceDiscordGuildId: G_MAIN,
    sourceRoleId: R_MAIN_MEMBER,
    targetGuildId: 'g2',
    targetDiscordGuildId: G_HCSO,
    targetRoleId: R_HCSO_MEMBER,
    direction: MappingDirection.ONE_WAY,
    authority: AuthoritySource.SOURCE_DISCORD,
    syncAdd: true,
    syncRemove: true,
    priority: 100,
    enabled: true,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    member: { id: 'user-1', displayName: 'Test Member', discordUserId: '700000000000000001' },
    guilds: GUILDS,
    managedRoles: managedRoles(),
    mappings: [mapping()],
    manualGrantManagedRoleIds: [],
    ...overrides,
  };
}

/** Runs the full pure pipeline and returns the plan. */
function plan(ctx, actual, { guilds = GUILDS, mappingOnly = false } = {}) {
  const actualByGuild = new Map(
    Object.entries(actual).map(([guildId, roles]) => [
      guildId,
      roles === null ? null : new Set(roles),
    ]),
  );
  const desiredState = computeDesiredState(ctx, actualByGuild, { mappingOnly });
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
  it('adds the mapped role when the source role is present', () => {
    const result = plan(context(), {
      [G_MAIN]: [R_MAIN_MEMBER],
      [G_HCSO]: [],
    });
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_MEMBER]);
  });

  it('never removes a role the platform does not control', () => {
    const result = plan(context(), {
      [G_MAIN]: [R_MAIN_MEMBER],
      [G_HCSO]: [R_HCSO_MEMBER, R_UNMANAGED],
    });
    expect(result.actions).toHaveLength(0);
  });

  it('is idempotent: a converged state produces no actions', () => {
    const converged = { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: [R_HCSO_MEMBER] };
    expect(plan(context(), converged).actions).toHaveLength(0);
    expect(plan(context(), converged).actions).toHaveLength(0);
  });

  it('is deterministic: the same input always yields the same ordered plan', () => {
    const state = { [G_MAIN]: [R_MAIN_MEMBER, R_MAIN_MEDIA], [G_HCSO]: [R_UNMANAGED] };
    const ctx = context({
      mappings: [
        mapping(),
        mapping({
          id: 'map-2',
          name: 'Media',
          sourceRoleId: R_MAIN_MEDIA,
          targetRoleId: R_HCSO_MEDIA,
        }),
      ],
    });
    expect(JSON.stringify(plan(ctx, state).actions)).toBe(JSON.stringify(plan(ctx, state).actions));
  });

  it('records a reason on every action', () => {
    const result = plan(context(), { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: [] });
    for (const action of result.actions) expect(action.reason).toBeTruthy();
    expect(result.actions[0].reason).toContain('mapping');
  });
});

describe('one-way mappings', () => {
  it('adds the target role when the source role is present', () => {
    const result = plan(context(), { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: [] });
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_MEMBER]);
  });

  it('removes the target role when the source role is gone', () => {
    const result = plan(context(), { [G_MAIN]: [], [G_HCSO]: [R_HCSO_MEMBER] });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_HCSO_MEMBER]);
  });

  it('does not remove the target role when removal sync is disabled', () => {
    const ctx = context({ mappings: [mapping({ syncRemove: false })] });
    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_HCSO_MEMBER] });
    expect(result.actions).toHaveLength(0);
  });

  it('does not add the target role when add sync is disabled', () => {
    const ctx = context({ mappings: [mapping({ syncAdd: false })] });
    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: [] });
    expect(result.actions).toHaveLength(0);
  });

  it('never propagates backwards on a one-way mapping', () => {
    const result = plan(context(), { [G_MAIN]: [], [G_HCSO]: [R_HCSO_MEMBER] });
    expect(result.actions.every((action) => action.discordGuildId === G_HCSO)).toBe(true);
  });
});

describe('two-way mappings', () => {
  const twoWayUnion = mapping({
    id: 'map-media',
    name: 'Media Team (union)',
    sourceRoleId: R_MAIN_MEDIA,
    targetRoleId: R_HCSO_MEDIA,
    direction: MappingDirection.TWO_WAY,
    authority: AuthoritySource.MANUAL,
  });

  it('propagates an add in either direction', () => {
    const ctx = context({ mappings: [twoWayUnion] });
    expect(
      actionsOf(plan(ctx, { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [] }), SyncActionType.ADD_ROLE),
    ).toEqual([R_HCSO_MEDIA]);
    expect(
      actionsOf(plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_HCSO_MEDIA] }), SyncActionType.ADD_ROLE),
    ).toEqual([R_MAIN_MEDIA]);
  });

  it('does not flip-flop: union mappings never remove during reconciliation', () => {
    const ctx = context({ mappings: [twoWayUnion] });
    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [] });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([]);
  });

  it('lets the source side win when it is authoritative', () => {
    const ctx = context({
      mappings: [{ ...twoWayUnion, authority: AuthoritySource.SOURCE_DISCORD }],
    });
    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_HCSO_MEDIA] });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_HCSO_MEDIA]);
  });

  it('lets the target side win when it is authoritative', () => {
    const ctx = context({
      mappings: [{ ...twoWayUnion, authority: AuthoritySource.TARGET_DISCORD }],
    });
    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [] });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_MAIN_MEDIA]);
  });
});

describe('mapping chains', () => {
  it('settles a chain in a single pass', () => {
    const guilds = [...GUILDS, { id: 'g3', discordGuildId: G_FHP, name: 'FHP' }];
    const chainA = mapping({ id: 'chain-a', name: 'A to B' });
    const chainB = mapping({
      id: 'chain-b',
      name: 'B to C',
      sourceGuildId: 'g2',
      sourceDiscordGuildId: G_HCSO,
      sourceRoleId: R_HCSO_MEMBER,
      targetGuildId: 'g3',
      targetDiscordGuildId: G_FHP,
      targetRoleId: R_CHAIN_END,
    });

    const ctx = context({ guilds, mappings: [chainA, chainB] });
    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: [], [G_FHP]: [] }, { guilds });

    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_HCSO_MEMBER, R_CHAIN_END].sort());
  });
});

describe('manual grants', () => {
  it('grants a manual role while the grant is active', () => {
    const ctx = context({ manualGrantManagedRoleIds: [`mr-${R_GRANTABLE}`] });
    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [] });
    expect(actionsOf(result, SyncActionType.ADD_ROLE)).toEqual([R_GRANTABLE]);
  });

  it('removes a manual role once the grant has expired or been revoked', () => {
    const ctx = context({ manualGrantManagedRoleIds: [] });
    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_GRANTABLE] });
    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([R_GRANTABLE]);
  });

  it('keeps a granted role even when a mapping wants it gone', () => {
    const hostile = mapping({
      id: 'map-hostile',
      name: 'Would remove the granted role',
      sourceRoleId: R_MAIN_MEDIA,
      targetRoleId: R_GRANTABLE,
    });
    const ctx = context({
      mappings: [hostile],
      manualGrantManagedRoleIds: [`mr-${R_GRANTABLE}`],
    });

    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_GRANTABLE] });

    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([]);
    expect(result.conflicts.some((c) => c.type === 'MAPPING_OVERRIDDEN_BY_GRANT')).toBe(true);
  });

  it('ignores grants entirely in mapping-only mode', () => {
    // An unlinked Discord account cannot hold a grant, so the grantable role must not
    // become removable for them.
    const ctx = context({ manualGrantManagedRoleIds: [] });
    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_GRANTABLE] }, { mappingOnly: true });
    expect(result.actions).toHaveLength(0);
  });
});

describe('members missing from a guild', () => {
  it('reports a warning instead of planning impossible actions', () => {
    const result = plan(context(), { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: null });
    expect(result.actions.every((action) => action.discordGuildId === G_MAIN)).toBe(true);
    expect(result.guildsMissingMember).toEqual([G_HCSO]);
    expect(result.warnings.some((w) => w.type === 'MEMBER_NOT_IN_GUILD')).toBe(true);
  });
});

describe('hands-off roles', () => {
  it('never touches a role marked as not platform managed', () => {
    const handsOff = role(G_HCSO, R_UNMANAGED, RolePurpose.MANUAL_GRANT, {
      managedByPlatform: false,
    });
    const ctx = context({ managedRoles: [...managedRoles(), handsOff] });
    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_UNMANAGED] });
    expect(result.actions).toHaveLength(0);
  });

  it('never treats a role of purpose OTHER as removable', () => {
    const other = role(G_HCSO, R_UNMANAGED, RolePurpose.OTHER, { name: 'Community Events' });
    const ctx = context({ managedRoles: [...managedRoles(), other] });
    const result = plan(ctx, { [G_MAIN]: [], [G_HCSO]: [R_UNMANAGED] });
    expect(result.actions).toHaveLength(0);
  });

  it('never removes a role that only appears as a mapping source', () => {
    // The source side of a one-way mapping is read, never written.
    const result = plan(context(), { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: [R_HCSO_MEMBER] });
    expect(result.actions).toHaveLength(0);
  });
});

describe('competing mappings', () => {
  it('lets the higher priority mapping decide', () => {
    const keep = mapping({
      id: 'keep',
      name: 'Keeps it',
      sourceRoleId: R_MAIN_MEDIA,
      priority: 200,
    });
    const drop = mapping({
      id: 'drop',
      name: 'Drops it',
      sourceRoleId: R_MAIN_MEMBER,
      priority: 100,
    });
    const ctx = context({ mappings: [keep, drop] });

    // Media is held (so `keep` wants the target), member is not (so `drop` wants it gone).
    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [R_HCSO_MEMBER] });

    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([]);
    expect(result.conflicts.some((c) => c.type === 'MAPPING_PRIORITY_CONFLICT')).toBe(true);
  });

  it('keeps the role and reports a tie when priorities are equal', () => {
    const keep = mapping({
      id: 'keep',
      name: 'Keeps it',
      sourceRoleId: R_MAIN_MEDIA,
      priority: 100,
    });
    const drop = mapping({
      id: 'drop',
      name: 'Drops it',
      sourceRoleId: R_MAIN_MEMBER,
      priority: 100,
    });
    const ctx = context({ mappings: [keep, drop] });

    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEDIA], [G_HCSO]: [R_HCSO_MEMBER] });

    expect(actionsOf(result, SyncActionType.REMOVE_ROLE)).toEqual([]);
    expect(result.conflicts.some((c) => c.type === 'MAPPING_TIE')).toBe(true);
  });
});

describe('plan summary', () => {
  it('counts adds, removes and conflicts for previews', () => {
    const ctx = context({ manualGrantManagedRoleIds: [`mr-${R_GRANTABLE}`] });
    const result = plan(ctx, { [G_MAIN]: [R_MAIN_MEMBER], [G_HCSO]: [] });
    const summary = summarizePlan(result);
    expect(summary.addCount).toBe(2);
    expect(summary.removeCount).toBe(0);
    expect(summary.totalActions).toBe(summary.addCount + summary.removeCount);
  });
});
