/**
 * Job retry policy.
 *
 * The requirement is "use exponential backoff for retryable failures, do not retry
 * permanent failures endlessly". Retrying "the bot does not have Manage Roles" five
 * times with backoff accomplishes nothing except consuming rate limit, so the processor
 * discards those jobs and leaves the recorded `SyncIssue` as the actionable output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordOperationError, RETRY_POLICY, SyncIssueType } from '@frm/shared';

const runSyncJob = vi.fn();
const runMappingValidation = vi.fn();
const runScheduledReconciliation = vi.fn();
const validateManagedRoles = vi.fn();

vi.mock('@frm/core', () => ({
  runSyncJob: (...args) => runSyncJob(...args),
  runMappingValidation: (...args) => runMappingValidation(...args),
  runScheduledReconciliation: (...args) => runScheduledReconciliation(...args),
  validateManagedRoles: (...args) => validateManagedRoles(...args),
}));

const { createMaintenanceProcessor, createSyncProcessor } =
  await import('../../apps/worker/src/processors.js');
const { JobName, DEFAULT_JOB_OPTIONS } = await import('@frm/queue');

/** Minimal stand-in for a BullMQ job. */
function fakeJob(overrides = {}) {
  return {
    id: 'queue-job-1',
    name: JobName.MEMBER_RESYNC,
    data: { syncJobId: 'sync-job-1' },
    attemptsMade: 0,
    discard: vi.fn(async () => {}),
    updateProgress: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('queue retry configuration', () => {
  it('uses exponential backoff with a bounded attempt count', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(RETRY_POLICY.attempts);
    expect(DEFAULT_JOB_OPTIONS.backoff.type).toBe('exponential');
    expect(DEFAULT_JOB_OPTIONS.backoff.delay).toBeGreaterThan(0);
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeLessThanOrEqual(10);
  });

  it('keeps failed jobs long enough to investigate', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail.age).toBeGreaterThanOrEqual(24 * 60 * 60);
  });
});

describe('sync processor', () => {
  beforeEach(() => {
    runSyncJob.mockReset();
  });

  it('returns the finished status on success', async () => {
    runSyncJob.mockResolvedValue({ status: 'COMPLETED' });
    const process = createSyncProcessor({ gateway: {} });

    const result = await process(fakeJob());

    expect(result).toEqual({ status: 'COMPLETED', syncJobId: 'sync-job-1' });
  });

  it('reports progress back to the queue', async () => {
    runSyncJob.mockImplementation(async ({ onProgress }) => {
      await onProgress({ completed: 5, total: 10 });
      return { status: 'COMPLETED' };
    });

    const job = fakeJob();
    await createSyncProcessor({ gateway: {} })(job);

    expect(job.updateProgress).toHaveBeenCalledWith(50);
  });

  it('retries a retryable failure', async () => {
    runSyncJob.mockRejectedValue(
      new DiscordOperationError({
        message: 'rate limited',
        issueType: SyncIssueType.RATE_LIMITED,
        retryable: true,
      }),
    );

    const job = fakeJob();
    await expect(createSyncProcessor({ gateway: {} })(job)).rejects.toThrow(/rate limited/i);

    // Throwing without discarding is what lets BullMQ apply the backoff and try again.
    expect(job.discard).not.toHaveBeenCalled();
  });

  it('discards a permanent failure instead of retrying it', async () => {
    runSyncJob.mockRejectedValue(
      new DiscordOperationError({
        message: 'missing permissions',
        issueType: SyncIssueType.BOT_MISSING_PERMISSION,
        retryable: false,
      }),
    );

    const job = fakeJob();
    await expect(createSyncProcessor({ gateway: {} })(job)).rejects.toThrow(/missing permissions/i);

    expect(job.discard).toHaveBeenCalledTimes(1);
  });

  it('treats an unexpected error as permanent rather than retrying blindly', async () => {
    runSyncJob.mockRejectedValue(new TypeError('undefined is not a function'));

    const job = fakeJob();
    await expect(createSyncProcessor({ gateway: {} })(job)).rejects.toThrow(TypeError);
    expect(job.discard).toHaveBeenCalledTimes(1);
  });
});

describe('maintenance processor', () => {
  beforeEach(() => {
    runMappingValidation.mockReset();
    runScheduledReconciliation.mockReset();
    validateManagedRoles.mockReset();
  });

  it('runs mapping validation and the managed-role check together', async () => {
    runMappingValidation.mockResolvedValue({ checked: 3, healthy: 3, disabled: 0 });
    validateManagedRoles.mockResolvedValue({ checked: 2, healthy: 2, problems: [] });

    const result = await createMaintenanceProcessor({ gateway: {} })(
      fakeJob({ name: JobName.MAPPING_VALIDATION }),
    );

    expect(runMappingValidation).toHaveBeenCalledOnce();
    expect(validateManagedRoles).toHaveBeenCalledOnce();
    expect(result.checked).toBe(3);
  });

  it('does not let a managed-role check failure fail the whole sweep', async () => {
    runMappingValidation.mockResolvedValue({ checked: 1 });
    validateManagedRoles.mockRejectedValue(new Error('discord unavailable'));

    const result = await createMaintenanceProcessor({ gateway: {} })(
      fakeJob({ name: JobName.MAPPING_VALIDATION }),
    );

    expect(result.checked).toBe(1);
  });

  it('runs scheduled reconciliation', async () => {
    runScheduledReconciliation.mockResolvedValue({ id: 'sync-job-9', status: 'COMPLETED' });

    const result = await createMaintenanceProcessor({ gateway: {} })(
      fakeJob({ name: JobName.SCHEDULED_RECONCILIATION }),
    );

    expect(result).toEqual({ syncJobId: 'sync-job-9', status: 'COMPLETED' });
  });

  it('ignores an unknown maintenance job', async () => {
    const result = await createMaintenanceProcessor({ gateway: {} })(
      fakeJob({ name: 'not-a-real-job' }),
    );
    expect(result).toEqual({ skipped: true });
  });
});
