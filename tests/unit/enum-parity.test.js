/**
 * `@frm/shared` duplicates the Prisma enums so that it does not have to depend on the
 * database package. This test is what keeps the duplication honest: if somebody adds a
 * value to `schema.prisma` and forgets `enums.js` (or the reverse), it fails here
 * rather than at runtime in a role calculation.
 */
import { describe, expect, it } from 'vitest';
import * as prismaClient from '@prisma/client';
import * as shared from '@frm/shared';

const PAIRS = [
  ['GuildType', shared.GuildType],
  ['UserStatus', shared.UserStatus],
  ['MappingDirection', shared.MappingDirection],
  ['AuthoritySource', shared.AuthoritySource],
  ['RolePurpose', shared.RolePurpose],
  ['ProtectionLevel', shared.ProtectionLevel],
  ['PermissionScopeType', shared.PermissionScopeType],
  ['SyncJobType', shared.SyncJobType],
  ['SyncJobStatus', shared.SyncJobStatus],
  ['SyncActionType', shared.SyncActionType],
  ['SyncActionStatus', shared.SyncActionStatus],
  ['SyncIssueType', shared.SyncIssueType],
  ['IssueSeverity', shared.IssueSeverity],
  ['PendingApprovalType', shared.PendingApprovalType],
  ['PendingApprovalStatus', shared.PendingApprovalStatus],
];

describe('enum parity between Prisma and @frm/shared', () => {
  it.each(PAIRS)('%s matches the generated Prisma enum', (name, sharedEnum) => {
    const prismaEnum = prismaClient[name];
    expect(prismaEnum, `Prisma does not export enum ${name}`).toBeDefined();
    expect(Object.keys(sharedEnum).sort()).toEqual(Object.keys(prismaEnum).sort());
    for (const key of Object.keys(prismaEnum)) {
      expect(sharedEnum[key]).toBe(prismaEnum[key]);
    }
  });

  it('maps ActionSource onto the Prisma ActionSource enum', () => {
    expect(Object.keys(shared.ActionSource).sort()).toEqual(
      Object.keys(prismaClient.ActionSource).sort(),
    );
  });
});
