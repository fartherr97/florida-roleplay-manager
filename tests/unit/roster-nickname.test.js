/**
 * Nickname rendering, parsing and rank resolution.
 *
 * These are the rules that run on every promotion in the community, so they are tested
 * directly rather than through the reconciler. The idempotence cases are the ones that
 * matter most: a renderer that is not idempotent stacks a prefix onto somebody's name
 * every single sync, and nobody notices until a staff member is called
 * `165 | Sr. Admin | 165 | Admin | 165 | Mod | Mike`.
 */
import { describe, expect, it } from 'vitest';
import {
  NICKNAME_MAX_LENGTH,
  buildManagedNickname,
  inferPreferredName,
  parseNickname,
  renderNickname,
} from '../../packages/core/src/roster-nickname.js';
import { rankShortName, resolveRank } from '../../packages/core/src/roster-resolve.js';

describe('renderNickname', () => {
  it('renders the house format', () => {
    expect(renderNickname({ callsign: '165', rank: 'Jr. Admin', name: 'Mike' })).toBe(
      '165 | Jr. Admin | Mike',
    );
    expect(renderNickname({ callsign: '905', rank: 'Major', name: 'Gene' })).toBe(
      '905 | Major | Gene',
    );
  });

  it('collapses a missing callsign rather than leaving an empty segment', () => {
    expect(renderNickname({ callsign: null, rank: 'Moderator', name: 'Mike' })).toBe(
      'Moderator | Mike',
    );
  });

  it('collapses a missing rank, which is how somebody leaves a roster', () => {
    expect(renderNickname({ callsign: '165', rank: null, name: 'Mike' })).toBe('165 | Mike');
    expect(renderNickname({ callsign: null, rank: null, name: 'Mike' })).toBe('Mike');
  });

  it('never exceeds the Discord nickname limit', () => {
    const rendered = renderNickname({
      callsign: '1650',
      rank: 'Senior Administrator',
      name: 'Bartholomew Fitzgerald',
    });
    expect(rendered.length).toBeLessThanOrEqual(NICKNAME_MAX_LENGTH);
  });

  it('truncates the name, never the callsign or the rank', () => {
    const rendered = renderNickname({
      callsign: '165',
      rank: 'Jr. Admin',
      name: 'Bartholomew Fitzgerald',
    });
    expect(rendered.startsWith('165 | Jr. Admin | ')).toBe(true);
    expect(rendered.length).toBeLessThanOrEqual(NICKNAME_MAX_LENGTH);
  });

  it('still produces a valid nickname when the prefix alone is over the limit', () => {
    const rendered = renderNickname({
      callsign: '1234567890',
      rank: 'Assistant Deputy Superintendent',
      name: 'Mike',
    });
    expect(rendered.length).toBeLessThanOrEqual(NICKNAME_MAX_LENGTH);
  });

  it('normalises stray whitespace', () => {
    expect(renderNickname({ callsign: ' 165 ', rank: 'Jr.  Admin', name: '  Mike ' })).toBe(
      '165 | Jr. Admin | Mike',
    );
  });
});

describe('parseNickname', () => {
  it('splits the house format back into its parts', () => {
    expect(parseNickname('165 | Jr. Admin | Mike')).toEqual({
      callsign: '165',
      rank: 'Jr. Admin',
      name: 'Mike',
    });
  });

  it('reads a bare name as a name', () => {
    expect(parseNickname('Mike')).toEqual({ callsign: null, rank: null, name: 'Mike' });
  });

  it('tells a callsign from a rank in a two-part nickname', () => {
    expect(parseNickname('165 | Mike')).toEqual({ callsign: '165', rank: null, name: 'Mike' });
    expect(parseNickname('Moderator | Mike')).toEqual({
      callsign: null,
      rank: 'Moderator',
      name: 'Mike',
    });
  });

  it('tolerates missing spaces around the separator', () => {
    expect(parseNickname('165|Jr. Admin|Mike')).toEqual({
      callsign: '165',
      rank: 'Jr. Admin',
      name: 'Mike',
    });
  });

  it('treats an empty nickname as an empty name rather than throwing', () => {
    expect(parseNickname(null).name).toBe('');
    expect(parseNickname('   ').name).toBe('');
    expect(parseNickname('||').name).toBe('');
  });
});

describe('buildManagedNickname', () => {
  it('is idempotent: rendering an already-managed nickname changes nothing', () => {
    const first = buildManagedNickname({
      currentNickname: 'Mike',
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(first.nickname).toBe('165 | Jr. Admin | Mike');

    const second = buildManagedNickname({
      currentNickname: first.nickname,
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(second.nickname).toBe(first.nickname);

    const third = buildManagedNickname({
      currentNickname: second.nickname,
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(third.nickname).toBe(first.nickname);
  });

  it('swaps the rank on promotion and keeps the name', () => {
    const promoted = buildManagedNickname({
      currentNickname: '165 | Mod | Mike',
      callsign: '165',
      rank: 'Sr. Admin',
    });
    expect(promoted.nickname).toBe('165 | Sr. Admin | Mike');
  });

  it('strips the managed prefix when the rank goes away', () => {
    const stripped = buildManagedNickname({
      currentNickname: '165 | Jr. Admin | Mike',
      callsign: null,
      rank: null,
    });
    expect(stripped.nickname).toBe('Mike');
  });

  it('prefers an explicitly set name over what the nickname says', () => {
    const built = buildManagedNickname({
      currentNickname: '165 | Jr. Admin | Michael',
      preferredName: 'Mike',
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(built.nickname).toBe('165 | Jr. Admin | Mike');
  });

  it('uses the synced name over the local nickname, but under an admin override', () => {
    // The name propagated from the member's authoritative guild wins over the name in
    // this guild's own nickname.
    const synced = buildManagedNickname({
      currentNickname: '165 | Jr. Admin | LocalName',
      syncedName: 'Jamison',
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(synced.nickname).toBe('165 | Jr. Admin | Jamison');

    // An administrator's explicit preferredName still outranks the synced name.
    const overridden = buildManagedNickname({
      currentNickname: '165 | Jr. Admin | LocalName',
      preferredName: 'Carter',
      syncedName: 'Jamison',
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(overridden.nickname).toBe('165 | Jr. Admin | Carter');
  });

  it('falls back to the username when there is no nickname at all', () => {
    const built = buildManagedNickname({
      currentNickname: null,
      fallbackName: 'mike_flrp',
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(built.nickname).toBe('165 | Jr. Admin | mike_flrp');
  });

  it('does not stack a prefix onto a hand-typed nickname in roughly the right shape', () => {
    const built = buildManagedNickname({
      currentNickname: '165|Jr Admin|Mike',
      callsign: '165',
      rank: 'Jr. Admin',
    });
    expect(built.nickname).toBe('165 | Jr. Admin | Mike');
  });

  it('does not stack when the name source itself carries a managed prefix', () => {
    // A promotion where the previous prefix leaked into the stored/preferred name.
    // Rendering it verbatim would produce "168 | Mod | 189 | Trial Mod".
    const built = buildManagedNickname({
      currentNickname: '189 | Trial Mod | Jordan',
      preferredName: '189 | Trial Mod | Jordan',
      callsign: '168',
      rank: 'Mod',
    });
    expect(built.nickname).toBe('168 | Mod | Jordan');
    expect(built.name).toBe('Jordan');
  });
});

describe('inferPreferredName', () => {
  it('recovers the name from an existing managed nickname', () => {
    expect(inferPreferredName({ nickname: '905 | Major | Gene' })).toBe('Gene');
  });

  it('uses the username when the member has no nickname', () => {
    expect(inferPreferredName({ nickname: null, username: 'gene_flrp' })).toBe('gene_flrp');
  });
});

describe('resolveRank', () => {
  const ranks = [
    { id: 'r-mod', discordRoleId: '1', name: 'Moderator', position: 10 },
    { id: 'r-admin', discordRoleId: '2', name: 'Administrator', position: 20 },
    { id: 'r-senior', discordRoleId: '3', name: 'Senior Administrator', position: 30 },
  ];

  it('returns null when no bound role is held', () => {
    expect(resolveRank(ranks, ['999'])).toBeNull();
    expect(resolveRank(ranks, [])).toBeNull();
  });

  it('returns the only rank a member holds', () => {
    expect(resolveRank(ranks, ['1'])?.name).toBe('Moderator');
  });

  it('takes the highest when several are held at once', () => {
    // The common real case: somebody is promoted and nobody removes the old role.
    expect(resolveRank(ranks, ['1', '2', '3'])?.name).toBe('Senior Administrator');
  });

  it('does not depend on the order the ranks arrive in', () => {
    const reversed = [...ranks].reverse();
    expect(resolveRank(reversed, ['1', '3'])?.name).toBe('Senior Administrator');
  });

  it('breaks a tie deterministically rather than by input order', () => {
    const tied = [
      { id: 'b', discordRoleId: '1', name: 'B', position: 10 },
      { id: 'a', discordRoleId: '2', name: 'A', position: 10 },
    ];
    expect(resolveRank(tied, ['1', '2']).id).toBe('a');
    expect(resolveRank([...tied].reverse(), ['1', '2']).id).toBe('a');
  });

  it('accepts a Set as well as an array', () => {
    expect(resolveRank(ranks, new Set(['2']))?.name).toBe('Administrator');
  });
});

describe('rankShortName', () => {
  it('prefers the abbreviation, and falls back to the full name', () => {
    expect(rankShortName({ name: 'Senior Administrator', shortName: 'Sr. Admin' })).toBe(
      'Sr. Admin',
    );
    expect(rankShortName({ name: 'Moderator', shortName: null })).toBe('Moderator');
    expect(rankShortName({ name: 'Moderator', shortName: '  ' })).toBe('Moderator');
    expect(rankShortName(null)).toBeNull();
  });
});
