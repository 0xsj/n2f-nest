import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import { err, failure, ok } from '../../../../shared/errors/index.js';
import type { SessionPruner } from '../ports/index.js';
import { PruneSessions } from './prune-sessions.js';

const now = new Date('2026-09-23T12:00:00.000Z');
const HOUR = 3600 * 1000;

function setup(result = ok(3) as Awaited<ReturnType<SessionPruner['prune']>>) {
  const calls: Parameters<SessionPruner['prune']>[0][] = [];
  const useCase = new PruneSessions({
    clock: new FakeClock(now),
    policy: { idleTimeoutMs: HOUR },
    pruner: {
      prune: async (input) => {
        calls.push(input);
        return result;
      },
    },
  });
  return { calls, useCase };
}

describe('PruneSessions', () => {
  it('deletes sessions that ended, or went idle, more than the retention ago', async () => {
    const { calls, useCase } = setup();

    const result = await useCase.execute({ retentionMs: 24 * HOUR, limit: 50 });

    expect(result).toEqual(ok({ pruned: 3 }));
    expect(calls).toEqual([
      {
        endedBefore: new Date(now.getTime() - 24 * HOUR),
        idleBefore: new Date(now.getTime() - 25 * HOUR),
        limit: 50,
      },
    ]);
  });

  it('refuses invalid bounds without touching storage', async () => {
    const { calls, useCase } = setup();

    for (const bounds of [
      { retentionMs: -1, limit: 1 },
      { retentionMs: 0, limit: 0 },
      { retentionMs: 1.5, limit: 1 },
    ]) {
      expect((await useCase.execute(bounds)).ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('reports storage failures as an Identity dependency failure', async () => {
    const { useCase } = setup(err(failure('unavailable', 'down', { type: 'postgres.unavailable' })));

    const result = await useCase.execute({ retentionMs: 0, limit: 1 });

    expect(result).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });
});
