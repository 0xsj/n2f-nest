import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Job } from './job.js';

const jobId = parse('01900000-0000-7000-8000-000000000021');
const organizationId = parse('01900000-0000-7000-8000-000000000001');
if (!jobId.ok || !organizationId.ok) throw new Error('Job fixture IDs are invalid');

const createdAt = new Date('2026-09-20T00:00:00.000Z');

describe('Job', () => {
  it('submits a queued job with bounded retry policy', () => {
    const result = Job.create({
      id: jobId.value,
      organizationId: organizationId.value,
      kind: 'document.process',
      maxAttempts: 3,
      createdAt,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('queued');
      expect(result.value.attempts).toBe(0);
      expect(result.value.maxAttempts).toBe(3);
      expect(result.value.startedAt).toBeNull();
    }
  });

  it('runs, fails, retries and completes immutably', () => {
    const submitted = Job.create({
      id: jobId.value,
      organizationId: organizationId.value,
      kind: 'document.process',
      maxAttempts: 2,
      createdAt,
    });
    if (!submitted.ok) throw new Error(submitted.error.message);

    const started = submitted.value.start(new Date('2026-09-20T01:00:00.000Z'));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(submitted.value.status).toBe('queued');
    expect(started.value.attempts).toBe(1);

    const failed = started.value.fail(new Date('2026-09-20T02:00:00.000Z'), 'provider.timeout');
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.status).toBe('failed');
    expect(failed.value.failureCode).toBe('provider.timeout');

    const retried = failed.value.retry(new Date('2026-09-20T03:00:00.000Z'));
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;

    const startedAgain = retried.value.start(new Date('2026-09-20T04:00:00.000Z'));
    expect(startedAgain.ok).toBe(true);
    if (!startedAgain.ok) return;
    const completed = startedAgain.value.complete(new Date('2026-09-20T05:00:00.000Z'));
    expect(completed.ok).toBe(true);
    if (completed.ok) expect(completed.value.status).toBe('succeeded');
  });

  it('prevents retry after attempts are exhausted', () => {
    const submitted = Job.create({
      id: jobId.value,
      organizationId: organizationId.value,
      kind: 'document.process',
      maxAttempts: 1,
      createdAt,
    });
    if (!submitted.ok) throw new Error(submitted.error.message);
    const started = submitted.value.start(new Date('2026-09-20T01:00:00.000Z'));
    if (!started.ok) throw new Error(started.error.message);
    const failed = started.value.fail(new Date('2026-09-20T02:00:00.000Z'), 'failed');
    if (!failed.ok) throw new Error(failed.error.message);

    const retried = failed.value.retry(new Date('2026-09-20T03:00:00.000Z'));
    expect(retried.ok).toBe(false);
    if (!retried.ok) expect(retried.error.type).toBe('job.attempts_exhausted');
  });

  it('rejects invalid job kinds', () => {
    const result = Job.create({
      id: jobId.value,
      organizationId: organizationId.value,
      kind: 'Document Process',
      createdAt,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('job.invalid_kind');
  });

  it('keeps an opaque subject without importing its domain', () => {
    const result = Job.create({
      id: jobId.value,
      organizationId: organizationId.value,
      kind: 'document.process',
      subject: { type: 'document', id: jobId.value },
      createdAt,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.subject).toEqual({
        type: 'document',
        id: jobId.value,
      });
    }
  });
});
