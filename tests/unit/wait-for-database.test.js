/**
 * Startup database wait.
 *
 * The behaviour that matters on a platform with private networking: a database that is
 * momentarily unreachable at boot must be retried, not treated as fatal, or a healthy
 * database crash-loops the process. A genuine misconfiguration (bad password, missing
 * database) must still fail fast rather than burn the whole retry budget.
 */
import { describe, expect, it, vi } from 'vitest';
import { waitForDatabase } from '@frm/database';

/** A fake Prisma whose `SELECT 1` fails a set number of times, then succeeds. */
function fakePrisma(failures, error) {
  let calls = 0;
  return {
    calls: () => calls,
    $queryRaw: vi.fn(async () => {
      calls += 1;
      if (calls <= failures) throw error;
      return [{ '?column?': 1 }];
    }),
  };
}

/** Prisma's "can't reach database server" is code P1001. */
const unreachable = Object.assign(new Error('Can’t reach database server'), { code: 'P1001' });

describe('waitForDatabase', () => {
  it('resolves once the database becomes reachable', async () => {
    const prisma = fakePrisma(3, unreachable);

    await expect(
      waitForDatabase({ prisma, attempts: 10, baseDelayMs: 1 }),
    ).resolves.toBeUndefined();

    expect(prisma.calls()).toBe(4); // three failures, then a success
  });

  it('gives up after the configured number of attempts', async () => {
    const prisma = fakePrisma(Infinity, unreachable);

    await expect(waitForDatabase({ prisma, attempts: 3, baseDelayMs: 1 })).rejects.toThrow(
      /reach database/i,
    );
    expect(prisma.calls()).toBe(3);
  });

  it('fails fast on an error that waiting cannot fix', async () => {
    // A wrong password (P1000) will never resolve by retrying, so it is thrown at once.
    const authError = Object.assign(new Error('Authentication failed'), { code: 'P1000' });
    const prisma = fakePrisma(Infinity, authError);

    await expect(waitForDatabase({ prisma, attempts: 10, baseDelayMs: 1 })).rejects.toThrow(
      /authentication failed/i,
    );
    expect(prisma.calls()).toBe(1); // no retry
  });
});
