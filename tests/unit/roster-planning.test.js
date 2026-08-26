/**
 * Roster planning: who belongs on a roster, at what rank, under what name.
 *
 * The reconciler applies whatever this decides, so the interesting cases are the ones
 * where doing the obvious thing would be wrong - a member who has left the server, a
 * member whose roles were all stripped, and above all a member who is already correct,
 * because a plan that finds work to do on a correct roster means every scheduled sweep
 * rewrites 40 nicknames for nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  makeCallsignAllocator,
  planMemberChange,
  planRosterChanges,
  presentRoster,
  resolveCallsign,
} from '../../packages/core/src/roster-resolve.js';

const roster = {
  id: 'roster-1',
  slug: 'staff',
  name: 'Staff Team',
  nicknameSyncEnabled: true,
};

const ranks = [
  { id: 'r-mod', discordRoleId: '100', name: 'Moderator', shortName: 'Mod', position: 10 },
  { id: 'r-admin', discordRoleId: '200', name: 'Administrator', shortName: 'Admin', position: 20 },
  {
    id: 'r-senior',
    discordRoleId: '300',
    name: 'Senior Administrator',
    shortName: 'Sr. Admin',
    position: 30,
  },
];

const member = (overrides = {}) => ({
  id: 'user-1',
  username: 'mike_flrp',
  nickname: null,
  roleIds: [],
  ...overrides,
});

const membership = (overrides = {}) => ({
  discordUserId: 'user-1',
  status: 'ACTIVE',
  rankId: 'r-mod',
  rank: ranks[0],
  callsign: '165',
  displayName: 'Mike',
  ...overrides,
});

describe('planMemberChange', () => {
  it('adds a member who has just been given a roster role', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: null,
      member: member({ roleIds: ['100'] }),
    });

    expect(change.type).toBe('ADD');
    expect(change.rank.name).toBe('Moderator');
    expect(change.nickname).toBe('Mod | mike_flrp');
    expect(change.actionable).toBe(true);
  });

  it('promotes a member and rewrites their nickname', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership(),
      member: member({ nickname: '165 | Mod | Mike', roleIds: ['300'] }),
    });

    expect(change.type).toBe('PROMOTE');
    expect(change.rank.name).toBe('Senior Administrator');
    expect(change.nickname).toBe('165 | Sr. Admin | Mike');
  });

  it('takes the highest rank when a promotion left the old role in place', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership(),
      member: member({ nickname: '165 | Mod | Mike', roleIds: ['100', '200'] }),
    });

    expect(change.rank.name).toBe('Administrator');
    expect(change.nickname).toBe('165 | Admin | Mike');
  });

  it('removes a member whose roster roles have all been stripped, and cleans the name', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership(),
      member: member({ nickname: '165 | Mod | Mike', roleIds: [] }),
    });

    expect(change.type).toBe('REMOVE');
    expect(change.rank).toBeNull();
    // The rank was ours to write; the name was never ours to take away.
    expect(change.nickname).toBe('Mike');
  });

  it('removes a member who has left the server, without a nickname to write', () => {
    const change = planMemberChange({ roster, ranks, membership: membership(), member: null });

    expect(change.type).toBe('REMOVE');
    expect(change.nickname).toBeNull();
  });

  it('does nothing for somebody who was never on the roster and holds no role', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: null,
      member: member({ roleIds: ['999'] }),
    });

    expect(change.type).toBe('NONE');
    expect(change.actionable).toBe(false);
  });

  it('finds no work when the member is already correct', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership(),
      member: member({ nickname: '165 | Mod | Mike', roleIds: ['100'] }),
    });

    expect(change.type).toBe('NONE');
    expect(change.actionable).toBe(false);
    expect(change.nickname).toBeNull();
  });

  it('rewrites a nickname somebody edited by hand, without touching their rank', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership(),
      member: member({ nickname: 'Mike', roleIds: ['100'] }),
    });

    expect(change.type).toBe('NICKNAME');
    expect(change.rank.name).toBe('Moderator');
    expect(change.nickname).toBe('165 | Mod | Mike');
  });

  it('adopts a name the member typed themselves, when no override is set', () => {
    // They renamed themselves to "Mikey". Nothing says otherwise, so that is their name
    // now - the platform restores the rank prefix around it, not the old name.
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership({ displayName: 'Mike' }),
      member: member({ nickname: 'Mikey', roleIds: ['100'] }),
    });

    expect(change.nickname).toBe('165 | Mod | Mikey');
  });

  it('restores an administrator-set name over one the member typed', () => {
    // An override exists, so renaming themselves does not stick.
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership({ preferredName: 'Mike', displayName: 'Mike' }),
      member: member({ nickname: 'Mikey', roleIds: ['100'] }),
    });

    expect(change.nickname).toBe('165 | Mod | Mike');
  });

  it('leaves nicknames alone entirely when the roster does not own them', () => {
    const change = planMemberChange({
      roster: { ...roster, nicknameSyncEnabled: false },
      ranks,
      membership: membership(),
      member: member({ nickname: 'whatever they like', roleIds: ['300'] }),
      nicknameSync: false,
    });

    expect(change.type).toBe('PROMOTE');
    expect(change.nickname).toBeNull();
  });

  it('does not re-remove somebody who already departed', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership({ status: 'DEPARTED', rankId: null, rank: null }),
      member: member({ roleIds: [] }),
    });

    expect(change.type).toBe('NONE');
    expect(change.actionable).toBe(false);
  });

  it('brings a departed member back when they are re-hired', () => {
    const change = planMemberChange({
      roster,
      ranks,
      membership: membership({ status: 'DEPARTED', rankId: null, rank: null }),
      member: member({ nickname: 'Mike', roleIds: ['200'] }),
    });

    expect(change.type).toBe('ADD');
    expect(change.rank.name).toBe('Administrator');
    expect(change.nickname).toBe('165 | Admin | Mike');
  });
});

describe('planRosterChanges', () => {
  it('plans the whole roster in one pass', () => {
    const changes = planRosterChanges({
      roster,
      ranks,
      memberships: [
        membership({ discordUserId: 'stays', displayName: 'Stays' }),
        membership({ discordUserId: 'leaves', displayName: 'Leaves' }),
      ],
      members: [
        // Already correct: must not appear in the plan at all.
        {
          id: 'stays',
          username: 'stays',
          nickname: '165 | Mod | Stays',
          roleIds: ['100'],
        },
        // Roles stripped: comes off the roster.
        { id: 'leaves', username: 'leaves', nickname: '165 | Mod | Leaves', roleIds: [] },
        // New starter nobody has told the platform about.
        { id: 'joins', username: 'joins', nickname: null, roleIds: ['300'] },
      ],
    });

    const byMember = Object.fromEntries(changes.map((c) => [c.discordUserId, c]));
    expect(Object.keys(byMember).sort()).toEqual(['joins', 'leaves']);
    expect(byMember.leaves.type).toBe('REMOVE');
    expect(byMember.joins.type).toBe('ADD');
    expect(byMember.joins.nickname).toBe('Sr. Admin | joins');
  });

  it('returns nothing at all for a roster that is already correct', () => {
    const changes = planRosterChanges({
      roster,
      ranks,
      memberships: [membership()],
      members: [member({ nickname: '165 | Mod | Mike', roleIds: ['100'] })],
    });

    // This is what makes the scheduled sweep safe to run every few hours.
    expect(changes).toEqual([]);
  });

  it('ignores guild members who hold no roster role', () => {
    const changes = planRosterChanges({
      roster,
      ranks,
      memberships: [],
      members: [{ id: 'civilian', username: 'civilian', nickname: null, roleIds: ['999'] }],
    });

    expect(changes).toEqual([]);
  });
});

describe('callsign auto-assignment', () => {
  // Ranks with a callsign block: Moderators 120–129, Admins 130–139.
  const rangedRanks = [
    {
      id: 'r-mod',
      discordRoleId: '100',
      name: 'Moderator',
      shortName: 'Mod',
      position: 10,
      callsignRangeStart: 120,
      callsignRangeEnd: 129,
    },
    {
      id: 'r-admin',
      discordRoleId: '200',
      name: 'Administrator',
      shortName: 'Admin',
      position: 20,
      callsignRangeStart: 130,
      callsignRangeEnd: 139,
    },
  ];

  describe('resolveCallsign', () => {
    it('keeps a callsign already inside the rank block', () => {
      expect(resolveCallsign(rangedRanks[0], '125', () => '120')).toBe('125');
    });

    it('reissues a number that belongs to a different rank block', () => {
      // 125 is a Moderator number; on promotion to Admin it moves into 130–139.
      expect(resolveCallsign(rangedRanks[1], '125', () => '130')).toBe('130');
    });

    it('issues one when the member has none', () => {
      expect(resolveCallsign(rangedRanks[0], null, () => '120')).toBe('120');
    });

    it('leaves a custom non-numeric callsign alone', () => {
      expect(resolveCallsign(rangedRanks[0], 'K9-1', () => '120')).toBe('K9-1');
    });

    it('keeps whatever they had when the rank has no block', () => {
      const plain = { id: 'x', name: 'Mod', shortName: 'Mod', position: 1 };
      expect(resolveCallsign(plain, '999', () => '120')).toBe('999');
      expect(resolveCallsign(plain, null, () => '120')).toBeNull();
    });
  });

  describe('makeCallsignAllocator', () => {
    it('hands out the lowest free number and reserves it', () => {
      const allocate = makeCallsignAllocator([
        { callsign: '120', status: 'ACTIVE' },
        { callsign: '122', status: 'ACTIVE' },
      ]);
      expect(allocate(rangedRanks[0])).toBe('121');
      expect(allocate(rangedRanks[0])).toBe('123');
    });

    it('ignores departed members when counting what is taken', () => {
      const allocate = makeCallsignAllocator([{ callsign: '120', status: 'DEPARTED' }]);
      expect(allocate(rangedRanks[0])).toBe('120');
    });

    it('returns null when the block is full', () => {
      const taken = Array.from({ length: 10 }, (_, i) => ({
        callsign: String(120 + i),
        status: 'ACTIVE',
      }));
      expect(makeCallsignAllocator(taken)(rangedRanks[0])).toBeNull();
    });
  });

  it('gives ??? when the block is full, and upgrades it once a number frees up', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ callsign: String(120 + i), status: 'ACTIVE' }));

    const noRoom = resolveCallsign(rangedRanks[0], null, makeCallsignAllocator(full));
    expect(noRoom).toBe('???');

    // 125 departed, so ??? should take it on the next pass rather than sticking.
    const withGap = full.map((m) => (m.callsign === '125' ? { ...m, status: 'DEPARTED' } : m));
    const upgraded = resolveCallsign(rangedRanks[0], '???', makeCallsignAllocator(withGap));
    expect(upgraded).toBe('125');
  });

  it('issues a callsign to a new member and puts it in their nickname', () => {
    const change = planMemberChange({
      roster,
      ranks: rangedRanks,
      membership: null,
      member: member({ roleIds: ['100'] }),
      allocateCallsign: makeCallsignAllocator([]),
    });

    expect(change.type).toBe('ADD');
    expect(change.callsign).toBe('120');
    expect(change.callsignChanged).toBe(true);
    expect(change.nickname).toBe('120 | Mod | mike_flrp');
  });

  it('moves a numeric callsign into the new block on promotion', () => {
    const change = planMemberChange({
      roster,
      ranks: rangedRanks,
      membership: membership({ callsign: '125', rankId: 'r-mod', rank: rangedRanks[0] }),
      member: member({ nickname: '125 | Mod | Mike', roleIds: ['200'] }),
      allocateCallsign: makeCallsignAllocator([{ callsign: '130', status: 'ACTIVE' }]),
    });

    expect(change.type).toBe('PROMOTE');
    expect(change.callsign).toBe('131');
    expect(change.nickname).toBe('131 | Admin | Mike');
  });

  it('gives two brand-new members distinct numbers in one pass', () => {
    const changes = planRosterChanges({
      roster,
      ranks: rangedRanks,
      memberships: [],
      members: [
        { id: 'a', username: 'ana', nickname: null, roleIds: ['100'] },
        { id: 'b', username: 'ben', nickname: null, roleIds: ['100'] },
      ],
    });

    const issued = changes.map((c) => c.callsign).sort();
    expect(issued).toEqual(['120', '121']);
  });

  it('persists a callsign even when nickname sync is off', () => {
    const change = planMemberChange({
      roster: { ...roster, nicknameSyncEnabled: false },
      ranks: rangedRanks,
      membership: membership({ callsign: null, rankId: 'r-mod', rank: rangedRanks[0] }),
      member: member({ nickname: 'Mike', roleIds: ['100'] }),
      nicknameSync: false,
      allocateCallsign: makeCallsignAllocator([]),
    });

    expect(change.callsign).toBe('120');
    expect(change.callsignChanged).toBe(true);
    expect(change.actionable).toBe(true);
    expect(change.nickname).toBeNull();
  });
});

describe('presentRoster', () => {
  it('orders ranks by seniority and members by callsign', () => {
    const view = presentRoster({
      slug: 'staff',
      name: 'Staff Team',
      description: null,
      position: 0,
      updatedAt: new Date('2026-01-01'),
      ranks,
      memberships: [
        {
          discordUserId: 'a',
          rankId: 'r-mod',
          status: 'ACTIVE',
          callsign: '165',
          displayName: 'Mike',
        },
        {
          discordUserId: 'b',
          rankId: 'r-mod',
          status: 'ACTIVE',
          callsign: '9',
          displayName: 'Ana',
        },
        {
          discordUserId: 'c',
          rankId: 'r-senior',
          status: 'ACTIVE',
          callsign: '905',
          displayName: 'Gene',
        },
        // Departed members are history, not roster entries.
        {
          discordUserId: 'd',
          rankId: 'r-mod',
          status: 'DEPARTED',
          callsign: '1',
          displayName: 'Old',
        },
      ],
    });

    expect(view.ranks.map((rank) => rank.name)).toEqual([
      'Senior Administrator',
      'Administrator',
      'Moderator',
    ]);
    // 9 before 165: callsigns sort numerically, not as strings.
    expect(view.ranks.at(-1).members.map((m) => m.callsign)).toEqual(['9', '165']);
    expect(view.ranks.flatMap((rank) => rank.members).map((m) => m.name)).not.toContain('Old');
  });

  it('exposes only fields a public roster page already shows', () => {
    const view = presentRoster({
      slug: 'staff',
      name: 'Staff Team',
      position: 0,
      ranks: [ranks[0]],
      memberships: [
        {
          discordUserId: 'a',
          rankId: 'r-mod',
          status: 'ACTIVE',
          callsign: '165',
          displayName: 'Mike',
          // Everything below is internal and must not reach the website.
          preferredName: 'Mike',
          userId: 'platform-uuid',
          managedNickname: '165 | Mod | Mike',
          id: 'membership-uuid',
        },
      ],
    });

    expect(Object.keys(view.ranks[0].members[0]).sort()).toEqual([
      'callsign',
      'discordUserId',
      'name',
      'since',
    ]);
  });
});
