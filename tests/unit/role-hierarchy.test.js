/**
 * The actor-side role ceiling: an operator may never hand out a role at or above their own
 * highest role. Mirrors Discord's own Manage Roles rule and guards `/role grant` and
 * `/temprole`.
 */
import { describe, expect, it } from 'vitest';
import { MockRoleGateway } from '@frm/discord';
import { assertActorAboveRole } from '@frm/core';

const GUILD = '100000000000000001';
const OWNER = '200000000000000001';
const ACTOR = '200000000000000002';
const OUTSIDER = '200000000000000003';

const ROLE_LOW = '300000000000000001'; // position 10
const ROLE_MID = '300000000000000002'; // position 50  (actor's highest)
const ROLE_HIGH = '300000000000000003'; // position 90

/** A guild where the actor's highest role sits at position 50. */
function makeGateway() {
  const gateway = new MockRoleGateway();
  gateway.defineGuild({ id: GUILD, ownerId: OWNER });
  gateway.defineRole(GUILD, { id: ROLE_LOW, position: 10 });
  gateway.defineRole(GUILD, { id: ROLE_MID, position: 50 });
  gateway.defineRole(GUILD, { id: ROLE_HIGH, position: 90 });
  gateway.defineMember(GUILD, { id: ACTOR, roleIds: [ROLE_MID] });
  gateway.defineMember(GUILD, { id: OWNER, roleIds: [] });
  return gateway;
}

const call = (gateway, actorId, roleId) =>
  assertActorAboveRole(gateway, {
    discordGuildId: GUILD,
    actorDiscordUserId: actorId,
    discordRoleId: roleId,
  });

describe('assertActorAboveRole', () => {
  it('allows handing out a role below the actor’s highest', async () => {
    await expect(call(makeGateway(), ACTOR, ROLE_LOW)).resolves.toBeUndefined();
  });

  it('refuses a role equal to the actor’s highest', async () => {
    await expect(call(makeGateway(), ACTOR, ROLE_MID)).rejects.toThrow(/highest role/i);
  });

  it('refuses a role above the actor’s highest', async () => {
    await expect(call(makeGateway(), ACTOR, ROLE_HIGH)).rejects.toMatchObject({
      code: 'RANK_CEILING',
    });
  });

  it('exempts the guild owner, who outranks every role', async () => {
    await expect(call(makeGateway(), OWNER, ROLE_HIGH)).resolves.toBeUndefined();
  });

  it('refuses an actor who is not a member of the guild', async () => {
    await expect(call(makeGateway(), OUTSIDER, ROLE_LOW)).rejects.toThrow(/member of that server/i);
  });

  it('is a no-op when there is no resolvable actor', async () => {
    await expect(call(makeGateway(), '', ROLE_HIGH)).resolves.toBeUndefined();
  });
});
