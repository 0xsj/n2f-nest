import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { TokenDigest } from '../../domain/token.js';
import { Authenticate, type Resolution, type QueryPorts } from './index.js';

const T0 = 1_700_000_000_000;
const uuid = (n: number): ID => {
  const r = parse(
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
  );
  if (!r.ok) throw Error('uuid');
  return r.value;
};
const value = <T>(r: Result<T, Failure>): T => {
  if (!r.ok) throw Error('expected success: ' + r.error.type);
  return r.value;
};
const refused = <T>(r: Result<T, Failure>): Failure => {
  if (r.ok) throw Error('expected failure');
  return r.error;
};
function fakes() {
  const calls: { digest?: TokenDigest; nowMs: number; idleTtlMs: number }[] =
    [];
  const state = {
    resolution: ok<Resolution>({
      outcome: 'admitted',
      principalId: uuid(1),
      sessionId: uuid(2),
      authEpoch: 7,
    }) as Result<Resolution, Failure>,
  };
  const digest = value(
    TokenDigest.parse('session', new Uint8Array(32).fill(4)),
  );
  const ports: QueryPorts = {
    clock: new FakeClock(new Date(T0)),
    digester: {
      digest(purpose, secret) {
        if (secret.reveal() !== 'good-token' || purpose !== 'session')
          return err(
            failure('invalid', 'invalid token', {
              type: 'identity.token_invalid',
            }),
          );
        return ok(digest);
      },
    },
    resolver: {
      async resolve(d, nowMs, idleTtlMs) {
        calls.push({ digest: d, nowMs, idleTtlMs });
        return state.resolution;
      },
    },
  };
  return { calls, state, ports, digest };
}
describe('authenticate (U08)', () => {
  it('resolves an admitted principal with now and the idle TTL', async () => {
    const f = fakes();
    const op = value(Authenticate.create(f.ports, { sessionIdleMs: 1800_000 }));
    expect(
      value(await op.execute({ token: new SecretString('good-token') })),
    ).toEqual({ principalId: uuid(1), sessionId: uuid(2), authEpoch: 7 });
    expect(f.calls).toEqual([
      { digest: f.digest, nowMs: T0, idleTtlMs: 1800_000 },
    ]);
  });
  it('treats malformed, absent and rejected identically and passes failures through', async () => {
    const f = fakes();
    const op = value(Authenticate.create(f.ports, { sessionIdleMs: 1800_000 }));
    const rejected = async (token: string) => {
      const e = refused(await op.execute({ token: new SecretString(token) }));
      expect(e.kind).toBe('unauthenticated');
      expect(e.type).toBe('identity.session_rejected');
    };
    await rejected('garbage');
    expect(f.calls).toEqual([]);
    f.state.resolution = ok({ outcome: 'absent' });
    await rejected('good-token');
    f.state.resolution = ok({ outcome: 'rejected' });
    await rejected('good-token');
    f.state.resolution = err(
      failure('unavailable', 'db', { type: 'postgres.unavailable' }),
    );
    expect(
      refused(await op.execute({ token: new SecretString('good-token') })).type,
    ).toBe('postgres.unavailable');
    (f.ports.clock as FakeClock).set(new Date(-5));
    expect(
      refused(await op.execute({ token: new SecretString('good-token') })).type,
    ).toBe('identity.auth_dependency_failed');
  });
  it('validates its configuration', () => {
    const f = fakes();
    expect(
      refused(Authenticate.create(f.ports, { sessionIdleMs: 0 })).type,
    ).toBe('identity.auth_configuration');
  });
});
