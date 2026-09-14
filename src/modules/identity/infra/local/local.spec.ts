import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import { Digest } from '../../../../shared/keyed/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { Email } from '../../domain/email.js';
import { NewPassword } from '../../domain/password.js';
import { createLimiter, loadBlocklist, undeliveredMail } from './index.js';

const value = <T>(r: Result<T, Failure>): T => {
  if (!r.ok) throw new Error('expected success: ' + r.error.type);
  return r.value;
};
const refused = <T>(r: Result<T, Failure>): Failure => {
  if (r.ok) throw new Error('expected failure');
  return r.error;
};
const keyed = () =>
  value(Digest.create(new SecretString('0123456789abcdef0123456789abcdef')));
const secret = (s: string) => new SecretString(s);
const clock = () => new FakeClock(new Date('2026-09-12T10:00:00Z'));

describe('process-local attempt limiter (L01–L03)', () => {
  it('counts subject and source buckets independently and refuses with retry-after', async () => {
    const c = clock();
    const limiter = value(
      createLimiter(keyed(), c, {
        operations: {
          login: {
            subject: { attempts: 2, windowMs: 60_000 },
            source: { attempts: 4, windowMs: 60_000 },
          },
        },
      }),
    );
    const a = secret('ada@example.com');
    expect(value(await limiter.admit('login', a, '10.0.0.1'))).toEqual({
      permitted: true,
    });
    expect(value(await limiter.admit('login', a, '10.0.0.1'))).toEqual({
      permitted: true,
    });
    const third = value(await limiter.admit('login', a, '10.0.0.1'));
    expect(third.permitted).toBe(false);
    if (!third.permitted) expect(third.retryAfterMs).toBe(60_000);
    // Every call counts (L01): the source bucket is at 3 after ada's refused third
    // attempt, so bob is the fourth and last permitted call from this source.
    expect(
      value(
        await limiter.admit('login', secret('bob@example.com'), '10.0.0.1'),
      ),
    ).toEqual({ permitted: true });
    // The fifth source attempt is refused even though the subject is fresh.
    const bySource = value(
      await limiter.admit('login', secret('cy@example.com'), '10.0.0.1'),
    );
    expect(bySource.permitted).toBe(false);
    // A different source is unaffected.
    expect(
      value(
        await limiter.admit('login', secret('dee@example.com'), '10.0.0.2'),
      ),
    ).toEqual({ permitted: true });
  });
  it('resets after the window expires and reports the remaining window', async () => {
    const c = clock();
    const limiter = value(
      createLimiter(keyed(), c, {
        operations: { verify: { subject: { attempts: 1, windowMs: 1000 } } },
      }),
    );
    const s = secret('digest-hex');
    value(await limiter.admit('verify', s, ''));
    c.set(new Date(c.now().getTime() + 400));
    const r = value(await limiter.admit('verify', s, ''));
    expect(r.permitted).toBe(false);
    if (!r.permitted) expect(r.retryAfterMs).toBe(600);
    c.set(new Date(c.now().getTime() + 600));
    expect(value(await limiter.admit('verify', s, ''))).toEqual({
      permitted: true,
    });
  });
  it('never stores the raw subject and refuses an unknown operation', async () => {
    const limiter = value(createLimiter(keyed(), clock()));
    value(
      await limiter.admit('login', secret('private-SENTINEL'), 'src-SENTINEL'),
    );
    expect(JSON.stringify(limiter.inspect())).not.toContain('SENTINEL');
    expect(
      refused(await limiter.admit('unknown_op', secret('x'), '')).type,
    ).toBe('identity.limiter_configuration');
  });
  it('evicts expired windows under the key bound and fails closed when full', async () => {
    const c = clock();
    const limiter = value(
      createLimiter(keyed(), c, {
        operations: { login: { subject: { attempts: 5, windowMs: 1000 } } },
        maxKeys: 2,
      }),
    );
    value(await limiter.admit('login', secret('a'), ''));
    value(await limiter.admit('login', secret('b'), ''));
    const full = await limiter.admit('login', secret('c'), '');
    expect(refused(full).type).toBe('identity.auth_dependency_failed');
    expect(refused(full).kind).toBe('unavailable');
    c.set(new Date(c.now().getTime() + 1001));
    expect(value(await limiter.admit('login', secret('c'), ''))).toEqual({
      permitted: true,
    });
  });
  it('refuses zero or negative limits and validates defaults', () => {
    expect(
      refused(
        createLimiter(keyed(), clock(), {
          operations: { login: { subject: { attempts: 0, windowMs: 1000 } } },
        }),
      ).type,
    ).toBe('identity.limiter_configuration');
    const limiter = value(createLimiter(keyed(), clock()));
    expect(limiter.operations()).toEqual([
      'login',
      'password_change',
      'register',
      'reset',
      'reset_request',
      'verification_request',
      'verify',
    ]);
  });
});

describe('file-backed enrollment policy (B01–B02)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n2f-blocklist-'));
  const list = join(dir, 'list.txt');
  writeFileSync(
    list,
    '# comment\n\nPassword123456789\ncorrect horse battery\nééééééééééééééé\n',
  );
  const pw = (s: string) => value(NewPassword.parse(new SecretString(s)));
  it('matches exactly under NFC and simple case folding, ignoring comments and blanks', async () => {
    const policy = value(loadBlocklist(list));
    expect(policy.size).toBe(3);
    expect(value(await policy.checkBlocklist(pw('password123456789')))).toBe(
      false,
    );
    expect(value(await policy.checkBlocklist(pw('PASSWORD123456789')))).toBe(
      false,
    );
    expect(value(await policy.checkBlocklist(pw('é'.repeat(15))))).toBe(false);
    expect(value(await policy.checkBlocklist(pw('password1234567890')))).toBe(
      true,
    );
    expect(value(await policy.checkBlocklist(pw('xpassword123456789')))).toBe(
      true,
    );
    expect(
      value(await policy.checkBlocklist(pw('correct horse battery staple'))),
    ).toBe(true);
    expect(JSON.stringify(policy)).not.toContain('correct horse');
  });
  it('refuses a missing, unreadable or empty list', () => {
    expect(refused(loadBlocklist(join(dir, 'missing.txt'))).type).toBe(
      'identity.blocklist_configuration',
    );
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, '# only a comment\n\n');
    expect(refused(loadBlocklist(empty)).type).toBe(
      'identity.blocklist_configuration',
    );
  });
});

describe('undelivered mail (M01)', () => {
  it('reports not delivered, counts per kind and retains nothing', async () => {
    const mail = undeliveredMail();
    const to = value(Email.parse('ada@example.com'));
    expect(await mail.sendVerification(to, secret('token-SENTINEL'), 1)).toBe(
      false,
    );
    expect(await mail.sendReset(to, secret('token-SENTINEL'), 1)).toBe(false);
    expect(await mail.sendReset(to, secret('token-SENTINEL'), 1)).toBe(false);
    expect(mail.counts()).toEqual({ verification: 1, reset: 2 });
    expect(JSON.stringify(mail)).not.toContain('SENTINEL');
    expect(JSON.stringify(mail)).not.toContain('ada@');
  });
});
