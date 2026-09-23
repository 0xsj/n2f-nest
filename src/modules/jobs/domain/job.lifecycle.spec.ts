import { describe, expect, it } from 'vitest';
import { parse } from '../../../shared/id/index.js';
import { Job, type CreateJobInput, type RestoreJobInput } from './job.js';

const jobId = parse('01900000-0000-7000-8000-000000000021');
const organizationId = parse('01900000-0000-7000-8000-000000000001');
const subjectId = parse('01900000-0000-7000-8000-000000000031');
if (!jobId.ok || !organizationId.ok || !subjectId.ok) {
  throw new Error('Job fixture IDs are invalid');
}

const t0 = new Date('2026-09-20T00:00:00.000Z');
const t1 = new Date('2026-09-20T01:00:00.000Z');
const t2 = new Date('2026-09-20T02:00:00.000Z');
const t3 = new Date('2026-09-20T03:00:00.000Z');
const t4 = new Date('2026-09-20T04:00:00.000Z');

function createInput(overrides: Partial<Record<keyof CreateJobInput, unknown>> = {}): CreateJobInput {
  return {
    id: jobId.value,
    organizationId: organizationId.value,
    kind: 'document.process',
    createdAt: t0,
    ...overrides,
  } as CreateJobInput;
}

function restoreInput(overrides: Partial<Record<keyof RestoreJobInput, unknown>> = {}): RestoreJobInput {
  return {
    id: jobId.value,
    organizationId: organizationId.value,
    kind: 'document.process',
    subject: null,
    status: 'queued',
    attempts: 0,
    maxAttempts: 3,
    createdAt: t0,
    updatedAt: t1,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
    version: 1,
    ...overrides,
  } as RestoreJobInput;
}

function mustCreate(overrides: Partial<Record<keyof CreateJobInput, unknown>> = {}): Job {
  const result = Job.create(createInput(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function mustRestore(overrides: Partial<Record<keyof RestoreJobInput, unknown>> = {}): Job {
  const result = Job.restore(restoreInput(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function must(result: ReturnType<Job['start']>): Job {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function failureType(result: { ok: boolean; error?: { type: string } }): string | undefined {
  expect(result.ok).toBe(false);
  return result.ok ? undefined : result.error?.type;
}

const running = (overrides: Partial<Record<keyof RestoreJobInput, unknown>> = {}) =>
  mustRestore({ status: 'running', attempts: 1, startedAt: t1, ...overrides });
const failed = (overrides: Partial<Record<keyof RestoreJobInput, unknown>> = {}) =>
  mustRestore({
    status: 'failed',
    attempts: 1,
    startedAt: t1,
    finishedAt: t1,
    failureCode: 'provider.timeout',
    ...overrides,
  });
const succeeded = () =>
  mustRestore({ status: 'succeeded', attempts: 1, startedAt: t1, finishedAt: t1 });
const canceled = () => mustRestore({ status: 'canceled', finishedAt: t1 });

describe('Job.create', () => {
  it('builds a fresh unsaved queued job from valid input', () => {
    const job = mustCreate({ subject: { type: 'document', id: subjectId.value } });
    expect(job.id).toBe(jobId.value);
    expect(job.organizationId).toBe(organizationId.value);
    expect(job.kind).toBe('document.process');
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.createdAt.getTime()).toBe(t0.getTime());
    expect(job.updatedAt.getTime()).toBe(t0.getTime());
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(job.failureCode).toBeNull();
    expect(job.version).toBe(0);
    expect(job.open).toBe(true);
  });

  it('defaults to three max attempts', () => {
    expect(mustCreate().maxAttempts).toBe(3);
  });

  it.each([1, 10])('accepts max attempts at the boundary %s', (maxAttempts) => {
    expect(mustCreate({ maxAttempts }).maxAttempts).toBe(maxAttempts);
  });

  it.each([0, 11, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null])(
    'rejects max attempts %s',
    (maxAttempts) => {
      const result = Job.create(createInput({ maxAttempts }));
      expect(failureType(result)).toBe('job.invalid_attempts');
      if (!result.ok) expect(result.error.kind).toBe('invalid');
    },
  );

  it.each(['a', 'a'.repeat(120), 'doc.process_v2-x', 'z9'])('accepts kind %j', (kind) => {
    expect(mustCreate({ kind }).kind).toBe(kind);
  });

  it.each(['', 'a'.repeat(121), '9job', 'Ab', 'aB', '.job', 'job kind', 'job/x', 42, null, undefined])(
    'rejects kind %j',
    (kind) => {
      const result = Job.create(createInput({ kind }));
      expect(failureType(result)).toBe('job.invalid_kind');
      if (!result.ok) expect(result.error.kind).toBe('invalid');
    },
  );

  it.each([null, undefined])('treats a %s subject as no subject', (subject) => {
    expect(mustCreate({ subject }).subject).toBeNull();
  });

  it('keeps a valid subject frozen and detached from the input', () => {
    const input = { type: 'document', id: subjectId.value };
    const job = mustCreate({ subject: input });
    input.type = 'other';
    expect(job.subject).toEqual({ type: 'document', id: subjectId.value });
    expect(Object.isFrozen(job.subject)).toBe(true);
  });

  it.each(['a', 'a'.repeat(64), 'doc_type.v1-x'])('accepts subject type %j', (type) => {
    expect(mustCreate({ subject: { type, id: subjectId.value } }).subject?.type).toBe(type);
  });

  it('rejects subjects that are arrays even with type and id properties', () => {
    const arr = Object.assign([], { type: 'document', id: subjectId.value });
    expect(failureType(Job.create(createInput({ subject: arr })))).toBe('job.invalid_subject');
  });

  it('rejects a function subject even with own type and id properties', () => {
    const fn = Object.assign(() => undefined, { type: 'document', id: subjectId.value });
    expect(failureType(Job.create(createInput({ subject: fn })))).toBe('job.invalid_subject');
  });

  it('rejects a subject type that only stringifies to a valid type', () => {
    const subject = { type: ['document'], id: subjectId.value };
    expect(failureType(Job.create(createInput({ subject })))).toBe('job.invalid_subject');
  });

  it('rejects subjects whose type and id are inherited rather than own', () => {
    const inherited = Object.create({ type: 'document', id: subjectId.value }) as object;
    expect(failureType(Job.create(createInput({ subject: inherited })))).toBe(
      'job.invalid_subject',
    );
  });

  it.each([
    ['a string', 'document'],
    ['a number', 7],
    ['missing type', { id: 'x' }],
    ['missing id', { type: 'document' }],
    ['non-string type', { type: 5, id: '01900000-0000-7000-8000-000000000031' }],
    ['empty type', { type: '', id: '01900000-0000-7000-8000-000000000031' }],
    ['uppercase-leading type', { type: 'Doc', id: '01900000-0000-7000-8000-000000000031' }],
    ['uppercase-trailing type', { type: 'doC', id: '01900000-0000-7000-8000-000000000031' }],
    ['digit-leading type', { type: '1doc', id: '01900000-0000-7000-8000-000000000031' }],
    ['overlong type', { type: 'a'.repeat(65), id: '01900000-0000-7000-8000-000000000031' }],
    ['non-string id', { type: 'document', id: 12 }],
    ['malformed id', { type: 'document', id: 'not-an-id' }],
  ])('rejects a subject that is %s', (_label, subject) => {
    const result = Job.create(createInput({ subject }));
    expect(failureType(result)).toBe('job.invalid_subject');
    if (!result.ok) expect(result.error.kind).toBe('invalid');
  });

  it.each([
    ['an invalid date', new Date('nope')],
    ['a date-like object', { getTime: () => t0.getTime() }],
    ['a timestamp number', t0.getTime()],
  ])('rejects %s as creation time', (_label, createdAt) => {
    const result = Job.create(createInput({ createdAt }));
    expect(failureType(result)).toBe('job.invalid_created_at');
    if (!result.ok) expect(result.error.kind).toBe('invalid');
  });

  it('validates kind, then attempts, then subject, then creation time', () => {
    const all = { kind: 'Bad', maxAttempts: 0, subject: 'x', createdAt: new Date('nope') };
    expect(failureType(Job.create(createInput(all)))).toBe('job.invalid_kind');
    expect(failureType(Job.create(createInput({ ...all, kind: 'ok' })))).toBe(
      'job.invalid_attempts',
    );
    expect(
      failureType(Job.create(createInput({ ...all, kind: 'ok', maxAttempts: 2 }))),
    ).toBe('job.invalid_subject');
  });

  it('copies the creation time so callers cannot mutate it', () => {
    const createdAt = new Date(t0.getTime());
    const job = mustCreate({ createdAt });
    createdAt.setTime(t4.getTime());
    expect(job.createdAt.getTime()).toBe(t0.getTime());
    expect(job.updatedAt.getTime()).toBe(t0.getTime());

    job.createdAt.setTime(t4.getTime());
    job.updatedAt.setTime(t4.getTime());
    expect(job.createdAt.getTime()).toBe(t0.getTime());
    expect(job.updatedAt.getTime()).toBe(t0.getTime());
  });
});

describe('Job.restore', () => {
  it('restores every field of a stored job', () => {
    const job = mustRestore({
      subject: { type: 'document', id: subjectId.value },
      status: 'failed',
      attempts: 2,
      maxAttempts: 4,
      createdAt: t0,
      updatedAt: t3,
      startedAt: t1,
      finishedAt: t2,
      failureCode: 'provider.timeout',
      version: 7,
    });
    expect(job.id).toBe(jobId.value);
    expect(job.organizationId).toBe(organizationId.value);
    expect(job.kind).toBe('document.process');
    expect(job.subject).toEqual({ type: 'document', id: subjectId.value });
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
    expect(job.maxAttempts).toBe(4);
    expect(job.createdAt.getTime()).toBe(t0.getTime());
    expect(job.updatedAt.getTime()).toBe(t3.getTime());
    expect(job.startedAt?.getTime()).toBe(t1.getTime());
    expect(job.finishedAt?.getTime()).toBe(t2.getTime());
    expect(job.failureCode).toBe('provider.timeout');
    expect(job.version).toBe(7);
  });

  it('copies stored dates in and out', () => {
    const dates = {
      createdAt: new Date(t0.getTime()),
      updatedAt: new Date(t2.getTime()),
      startedAt: new Date(t1.getTime()),
      finishedAt: new Date(t2.getTime()),
    };
    const job = mustRestore({ status: 'succeeded', attempts: 1, ...dates });
    for (const d of Object.values(dates)) d.setTime(t4.getTime());
    expect(job.createdAt.getTime()).toBe(t0.getTime());
    expect(job.updatedAt.getTime()).toBe(t2.getTime());
    expect(job.startedAt?.getTime()).toBe(t1.getTime());
    expect(job.finishedAt?.getTime()).toBe(t2.getTime());

    job.startedAt?.setTime(t4.getTime());
    job.finishedAt?.setTime(t4.getTime());
    expect(job.startedAt?.getTime()).toBe(t1.getTime());
    expect(job.finishedAt?.getTime()).toBe(t2.getTime());
  });

  it('rejects an invalid kind and subject with their own failure types', () => {
    expect(failureType(Job.restore(restoreInput({ kind: 'Bad' })))).toBe('job.invalid_kind');
    expect(
      failureType(Job.restore(restoreInput({ subject: { type: 'Bad', id: subjectId.value } }))),
    ).toBe('job.invalid_subject');
  });

  it.each([
    ['attempts 0 with max 1', { attempts: 0, maxAttempts: 1 }],
    ['max attempts 10', { maxAttempts: 10 }],
    ['attempts equal to max', { status: 'failed', attempts: 3, maxAttempts: 3, startedAt: t1, finishedAt: t1, failureCode: 'x' }],
    ['version 1', { version: 1 }],
    ['equal created and updated times', { updatedAt: t0 }],
    ['a 128-char failure code', { status: 'failed', attempts: 1, startedAt: t1, finishedAt: t1, failureCode: 'a'.repeat(128) }],
    ['a canceled job that never started', { status: 'canceled', finishedAt: t1 }],
  ])('accepts %s', (_label, overrides) => {
    expect(Job.restore(restoreInput(overrides)).ok).toBe(true);
  });

  it.each([
    ['unknown status', { status: 'paused' }],
    ['fractional attempts', { attempts: 0.5 }],
    ['fractional max attempts', { maxAttempts: 2.5 }],
    ['negative attempts', { attempts: -1 }],
    ['max attempts 0', { maxAttempts: 0 }],
    ['max attempts 11', { maxAttempts: 11 }],
    ['attempts above max', { status: 'running', attempts: 4, maxAttempts: 3, startedAt: t1 }],
    ['invalid createdAt', { createdAt: new Date('nope') }],
    ['invalid updatedAt', { updatedAt: new Date('nope') }],
    ['invalid startedAt', { status: 'running', attempts: 1, startedAt: new Date('nope') }],
    ['invalid finishedAt', { status: 'canceled', finishedAt: new Date('nope') }],
    ['malformed failure code', { status: 'failed', attempts: 1, startedAt: t1, finishedAt: t1, failureCode: 'Bad' }],
    ['failure code with trailing uppercase', { status: 'failed', attempts: 1, startedAt: t1, finishedAt: t1, failureCode: 'baD' }],
    ['overlong failure code', { status: 'failed', attempts: 1, startedAt: t1, finishedAt: t1, failureCode: 'a'.repeat(129) }],
    ['unsaved version', { version: 0 }],
    ['queued with startedAt', { startedAt: t1 }],
    ['queued with finishedAt', { finishedAt: t1 }],
    ['queued with failureCode', { failureCode: 'x' }],
    ['running without startedAt', { status: 'running', attempts: 1 }],
    ['running with finishedAt', { status: 'running', attempts: 1, startedAt: t1, finishedAt: t1 }],
    ['running with failureCode', { status: 'running', attempts: 1, startedAt: t1, failureCode: 'x' }],
    ['running with zero attempts', { status: 'running', attempts: 0, startedAt: t1 }],
    ['succeeded without startedAt', { status: 'succeeded', attempts: 1, finishedAt: t1 }],
    ['succeeded without finishedAt', { status: 'succeeded', attempts: 1, startedAt: t1 }],
    ['succeeded with failureCode', { status: 'succeeded', attempts: 1, startedAt: t1, finishedAt: t1, failureCode: 'x' }],
    ['failed without startedAt', { status: 'failed', attempts: 1, finishedAt: t1, failureCode: 'x' }],
    ['failed without finishedAt', { status: 'failed', attempts: 1, startedAt: t1, failureCode: 'x' }],
    ['failed without failureCode', { status: 'failed', attempts: 1, startedAt: t1, finishedAt: t1 }],
    ['canceled without finishedAt', { status: 'canceled' }],
  ])('rejects %s as invalid state', (_label, overrides) => {
    const result = Job.restore(restoreInput(overrides));
    expect(failureType(result)).toBe('job.invalid_state');
    if (!result.ok) expect(result.error.kind).toBe('invalid');
  });

  it('rejects an update time that precedes creation', () => {
    const result = Job.restore(restoreInput({ createdAt: t2, updatedAt: t1 }));
    expect(failureType(result)).toBe('job.non_monotonic_time');
    if (!result.ok) expect(result.error.kind).toBe('invalid');
  });
});

describe('Job.open', () => {
  it('is open while queued or running', () => {
    expect(mustRestore().open).toBe(true);
    expect(running().open).toBe(true);
  });

  it('is open when failed with attempts left and closed once exhausted', () => {
    expect(failed({ attempts: 2, maxAttempts: 3 }).open).toBe(true);
    expect(failed({ attempts: 3, maxAttempts: 3 }).open).toBe(false);
  });

  it('is closed once succeeded or canceled', () => {
    expect(succeeded().open).toBe(false);
    expect(canceled().open).toBe(false);
  });
});

describe('Job transitions', () => {
  it('start moves a queued job to running and counts the attempt', () => {
    const queued = mustRestore({ attempts: 1, version: 5 });
    const at = new Date(t2.getTime());
    const started = must(queued.start(at));
    at.setTime(t4.getTime());

    expect(started.status).toBe('running');
    expect(started.attempts).toBe(2);
    expect(started.updatedAt.getTime()).toBe(t2.getTime());
    expect(started.startedAt?.getTime()).toBe(t2.getTime());
    expect(started.finishedAt).toBeNull();
    expect(started.failureCode).toBeNull();
    expect(started.version).toBe(5);
    expect(started.createdAt.getTime()).toBe(t0.getTime());
    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBe(1);
    expect(queued.startedAt).toBeNull();
  });

  it('start accepts a time equal to the last update', () => {
    expect(mustRestore().start(t1).ok).toBe(true);
  });

  it('start refuses non-queued jobs', () => {
    for (const job of [running(), failed(), succeeded(), canceled()]) {
      expect(failureType(job.start(t4))).toBe('job.not_queued');
    }
  });

  it('start refuses a queued job whose attempts are exhausted', () => {
    const result = mustRestore({ attempts: 3, maxAttempts: 3 }).start(t2);
    expect(failureType(result)).toBe('job.attempts_exhausted');
    expect(mustRestore({ attempts: 2, maxAttempts: 3 }).start(t2).ok).toBe(true);
  });

  it('complete finishes a running job successfully', () => {
    const job = running({ updatedAt: t1 });
    const done = must(job.complete(t3));
    expect(done.status).toBe('succeeded');
    expect(done.updatedAt.getTime()).toBe(t3.getTime());
    expect(done.finishedAt?.getTime()).toBe(t3.getTime());
    expect(done.startedAt?.getTime()).toBe(t1.getTime());
    expect(done.attempts).toBe(1);
    expect(done.failureCode).toBeNull();
    expect(job.status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });

  it('complete refuses jobs that are not running', () => {
    for (const job of [mustRestore(), failed(), succeeded(), canceled()]) {
      expect(failureType(job.complete(t4))).toBe('job.not_running');
    }
  });

  it('fail records the failure code on a running job', () => {
    const job = running();
    const out = must(job.fail(t3, 'provider.timeout'));
    expect(out.status).toBe('failed');
    expect(out.failureCode).toBe('provider.timeout');
    expect(out.updatedAt.getTime()).toBe(t3.getTime());
    expect(out.finishedAt?.getTime()).toBe(t3.getTime());
    expect(out.startedAt?.getTime()).toBe(t1.getTime());
    expect(out.attempts).toBe(1);
    expect(job.status).toBe('running');
    expect(job.failureCode).toBeNull();
  });

  it.each(['a', 'a'.repeat(128), 'x9_.-'])('fail accepts code %j', (code) => {
    expect(must(running().fail(t3, code)).failureCode).toBe(code);
  });

  it.each(['', 'Bad', 'baD', '9bad', 'a'.repeat(129), 'has space', 3, null, undefined])(
    'fail rejects code %j',
    (code) => {
      const result = running().fail(t3, code);
      expect(failureType(result)).toBe('job.invalid_failure_code');
      if (!result.ok) expect(result.error.kind).toBe('invalid');
    },
  );

  it('fail checks status before the failure code', () => {
    for (const job of [mustRestore(), failed(), succeeded(), canceled()]) {
      expect(failureType(job.fail(t4, 'Bad Code'))).toBe('job.not_running');
    }
  });

  it('retry requeues a failed job with attempts left, keeping the attempt count', () => {
    const job = failed({ attempts: 1, maxAttempts: 3, updatedAt: t1 });
    const out = must(job.retry(t3));
    expect(out.status).toBe('queued');
    expect(out.attempts).toBe(1);
    expect(out.updatedAt.getTime()).toBe(t3.getTime());
    expect(out.startedAt).toBeNull();
    expect(out.finishedAt).toBeNull();
    expect(out.failureCode).toBeNull();
    expect(job.status).toBe('failed');
    expect(job.failureCode).toBe('provider.timeout');
  });

  it('retry refuses non-failed jobs', () => {
    for (const job of [mustRestore(), running(), succeeded(), canceled()]) {
      expect(failureType(job.retry(t4))).toBe('job.not_failed');
    }
  });

  it('retry refuses exhausted failures', () => {
    expect(failureType(failed({ attempts: 3, maxAttempts: 3 }).retry(t4))).toBe(
      'job.attempts_exhausted',
    );
    expect(failed({ attempts: 2, maxAttempts: 3 }).retry(t4).ok).toBe(true);
  });

  it.each([
    ['queued', () => mustRestore()],
    ['running', () => running()],
    ['failed', () => failed()],
  ])('cancel ends a %s job', (_label, make) => {
    const job = make();
    const out = must(job.cancel(t3));
    expect(out.status).toBe('canceled');
    expect(out.updatedAt.getTime()).toBe(t3.getTime());
    expect(out.finishedAt?.getTime()).toBe(t3.getTime());
    expect(out.failureCode).toBeNull();
    expect(out.startedAt?.getTime() ?? null).toBe(job.startedAt?.getTime() ?? null);
    expect(out.attempts).toBe(job.attempts);
    expect(out.open).toBe(false);
    expect(job.status).toBe(_label);
  });

  it('cancel refuses succeeded or already canceled jobs', () => {
    expect(failureType(succeeded().cancel(t4))).toBe('job.not_cancelable');
    expect(failureType(canceled().cancel(t4))).toBe('job.not_cancelable');
  });

  describe.each([
    ['start', (j: Job, at: Date) => j.start(at), () => mustRestore()],
    ['complete', (j: Job, at: Date) => j.complete(at), () => running()],
    ['fail', (j: Job, at: Date) => j.fail(at, 'x'), () => running()],
    ['retry', (j: Job, at: Date) => j.retry(at), () => failed()],
    ['cancel', (j: Job, at: Date) => j.cancel(at), () => mustRestore()],
  ])('%s transition time', (_name, act, make) => {
    it('rejects an invalid time', () => {
      const result = act(make(), new Date('nope'));
      expect(failureType(result)).toBe('job.invalid_time');
      if (!result.ok) expect(result.error.kind).toBe('invalid');
    });

    it('rejects a non-Date time', () => {
      const fake = { getTime: () => t4.getTime() } as unknown as Date;
      expect(failureType(act(make(), fake))).toBe('job.invalid_time');
    });

    it('rejects a time earlier than the last update', () => {
      const result = act(make(), t0);
      expect(failureType(result)).toBe('job.non_monotonic_time');
      if (!result.ok) expect(result.error.kind).toBe('invalid');
    });

    it('accepts a time equal to the last update', () => {
      expect(act(make(), new Date(t1.getTime())).ok).toBe(true);
    });
  });

  it('checks time before status', () => {
    expect(failureType(succeeded().start(new Date('nope')))).toBe('job.invalid_time');
    expect(failureType(succeeded().complete(t0))).toBe('job.non_monotonic_time');
    expect(failureType(succeeded().fail(t0, 'Bad'))).toBe('job.non_monotonic_time');
    expect(failureType(succeeded().retry(t0))).toBe('job.non_monotonic_time');
    expect(failureType(succeeded().cancel(t0))).toBe('job.non_monotonic_time');
  });

  it('transition results expose copies of their dates', () => {
    const started = must(mustRestore().start(t2));
    started.startedAt?.setTime(t4.getTime());
    started.updatedAt.setTime(t4.getTime());
    expect(started.startedAt?.getTime()).toBe(t2.getTime());
    expect(started.updatedAt.getTime()).toBe(t2.getTime());
    // a later transition still measures monotonicity against the stored time
    expect(started.complete(t3).ok).toBe(true);
  });
});

describe('Job.saved', () => {
  it('advances the version and keeps the rest of the state', () => {
    const job = mustCreate();
    const once = job.saved();
    const twice = once.saved();
    expect(job.version).toBe(0);
    expect(once.version).toBe(1);
    expect(twice.version).toBe(2);
    expect(twice.status).toBe('queued');
    expect(twice.kind).toBe(job.kind);
    expect(twice.createdAt.getTime()).toBe(t0.getTime());
  });

  it('keeps the version across transitions', () => {
    const job = mustCreate().saved();
    expect(must(job.start(t1)).version).toBe(1);
  });
});
