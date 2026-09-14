import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Sequence, parse, type ID } from '../../../../shared/id/index.js';
import * as p from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { Email } from '../../domain/email.js';
import { TokenDigest, type TokenPurpose } from '../../domain/token.js';
import type { Snapshot } from '../../domain/principal.js';
import type { CredentialSnapshot } from '../../domain/credential.js';
import type { ChallengeSnapshot } from '../../domain/challenge.js';
import type { AuthenticatedPrincipal } from '../query/index.js';
import {
  ChangePassword,
  DEFAULT_CONFIG,
  Login,
  Logout,
  LogoutAll,
  Register,
  RequestReset,
  RequestVerification,
  ResetPassword,
  VerifyEmail,
  validateConfig,
  type Admission,
  type ChallengeRecord,
  type CredentialRecord,
  type Ports,
} from './index.js';

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
const work = (): p.WorkContext =>
  value(
    p.restoreWork({
      workId: uuid(0xa1),
      correlationId: uuid(0xa2),
      correlationSource: 'local',
      operation: value(p.operation('identity.test')),
      attribution: value(p.attribution({ initiator: p.anonymous() })),
    }),
  );
const secretText = (s: SecretString) => s.reveal();
const email = (text: string): Email => value(Email.parse(text));
const digestOf = (purpose: TokenPurpose, seed: number): TokenDigest =>
  value(TokenDigest.parse(purpose, new Uint8Array(32).fill(seed)));
const uncertain = () =>
  failure('timeout', 'commit acknowledgement lost', {
    type: 'database.commit_uncertain',
  });
const down = () =>
  failure('unavailable', 'store down', { type: 'postgres.unavailable' });

type Fakes = ReturnType<typeof fakes>;
function fakes() {
  const calls: string[] = [];
  const clock = new FakeClock(new Date(T0));
  const ids = new Sequence(Array.from({ length: 12 }, (_, i) => uuid(i + 1)));
  const knownPassword = 'correct horse battery staple';
  const state = {
    hashFailure: undefined as Failure | undefined,
    blocklisted: new Set<string>(),
    policyFailure: undefined as Failure | undefined,
    admission: { permitted: true } as Admission,
    limiterFailure: undefined as Failure | undefined,
    mailDelivered: true,
    mailThrows: false,
    registerOutcome: ok<'created' | 'duplicate_email'>('created') as Result<
      'created' | 'duplicate_email',
      Failure
    >,
    credentials: new Map<string, CredentialRecord>(),
    byPrincipal: new Map<string, CredentialRecord>(),
    readFailure: undefined as Failure | undefined,
    loginOutcome: ok<'committed' | 'stale'>('committed') as Result<
      'committed' | 'stale',
      Failure
    >,
    revokeOutcome: ok<'revoked' | 'already_inactive' | 'absent'>(
      'revoked',
    ) as Result<'revoked' | 'already_inactive' | 'absent', Failure>,
    epochOutcome: ok<'committed' | 'stale'>('committed') as Result<
      'committed' | 'stale',
      Failure
    >,
    challenges: new Map<string, ChallengeRecord>(),
    issueOutcome: ok<'issued' | 'stale'>('issued') as Result<
      'issued' | 'stale',
      Failure
    >,
    verifyOutcome: ok<'committed' | 'stale'>('committed') as Result<
      'committed' | 'stale',
      Failure
    >,
    passwordOutcome: ok<'committed' | 'stale'>('committed') as Result<
      'committed' | 'stale',
      Failure
    >,
  };
  const records = {
    limiter: [] as { op: string; subject: string; source: string }[],
    mail: [] as {
      kind: string;
      email: string;
      token: string;
      expiresAtMs: number;
    }[],
    register: [] as Parameters<Ports['store']['register']>[0][],
    login: [] as Parameters<Ports['store']['commitLogin']>[0][],
    revoke: [] as {
      sessionId: ID;
      principalId: ID;
      nowMs: number;
      event: Envelope;
    }[],
    revokeAll: [] as {
      principalId: ID;
      expectedEpoch: number;
      nowMs: number;
      event: Envelope;
    }[],
    issue: [] as Parameters<Ports['store']['issueChallenge']>[0][],
    verify: [] as Parameters<Ports['store']['verifyEmail']>[0][],
    change: [] as Parameters<Ports['store']['changePassword']>[0][],
    reset: [] as Parameters<Ports['store']['resetPassword']>[0][],
  };
  let tokenCounter = 0;
  const digestKey = (d: TokenDigest) => d.purpose() + ':' + d.bytes()[0];
  const ports: Ports = {
    clock,
    ids,
    hasher: {
      async hash(password) {
        calls.push('hash');
        if (state.hashFailure) return err(state.hashFailure);
        return ok(new SecretString('$hash$' + password.secret().reveal()));
      },
      async verify(input, record) {
        calls.push('verify');
        if (state.hashFailure) return err(state.hashFailure);
        return ok(record.reveal() === '$hash$' + input.secret().reveal());
      },
      async verifyAbsent() {
        calls.push('verifyAbsent');
        if (state.hashFailure) return err(state.hashFailure);
        return ok(false);
      },
    },
    codec: {
      issue(purpose) {
        calls.push('issue:' + purpose);
        tokenCounter += 1;
        return ok({
          secret: new SecretString('tok-' + purpose + '-' + tokenCounter),
          digest: digestOf(purpose, tokenCounter),
        });
      },
      digest(purpose, secret) {
        const m = /^tok-([a-z_]+)-(\d+)$/.exec(secret.reveal());
        if (!m)
          return err(
            failure('invalid', 'invalid token', {
              type: 'identity.token_invalid',
            }),
          );
        // A token digested under another purpose yields a different digest (T03).
        return ok(digestOf(purpose, m[1] === purpose ? Number(m[2]) : 0xee));
      },
    },
    policy: {
      async checkBlocklist(password) {
        calls.push('blocklist');
        if (state.policyFailure) return err(state.policyFailure);
        return ok(!state.blocklisted.has(password.secret().reveal()));
      },
    },
    limiter: {
      async admit(op, subject, source) {
        calls.push('admit:' + op);
        records.limiter.push({ op, subject: subject.reveal(), source });
        if (state.limiterFailure) return err(state.limiterFailure);
        return ok(state.admission);
      },
    },
    mail: {
      async sendVerification(to, token, expiresAtMs) {
        calls.push('mail:verification');
        if (state.mailThrows) throw Error('smtp');
        records.mail.push({
          kind: 'verification',
          email: to.reveal(),
          token: token.reveal(),
          expiresAtMs,
        });
        return state.mailDelivered;
      },
      async sendReset(to, token, expiresAtMs) {
        calls.push('mail:reset');
        if (state.mailThrows) throw Error('smtp');
        records.mail.push({
          kind: 'reset',
          email: to.reveal(),
          token: token.reveal(),
          expiresAtMs,
        });
        return state.mailDelivered;
      },
    },
    store: {
      async register(record) {
        calls.push('store:register');
        records.register.push(record);
        return state.registerOutcome;
      },
      async findByEmail(e) {
        calls.push('store:findByEmail');
        if (state.readFailure) return err(state.readFailure);
        return ok(state.credentials.get(e.reveal()));
      },
      async findByPrincipal(id) {
        calls.push('store:findByPrincipal');
        if (state.readFailure) return err(state.readFailure);
        return ok(state.byPrincipal.get(id));
      },
      async commitLogin(record) {
        calls.push('store:commitLogin');
        records.login.push(record);
        return state.loginOutcome;
      },
      async revokeSession(sessionId, principalId, nowMs, event) {
        calls.push('store:revokeSession');
        records.revoke.push({ sessionId, principalId, nowMs, event });
        return state.revokeOutcome;
      },
      async revokeAll(principalId, expectedEpoch, nowMs, event) {
        calls.push('store:revokeAll');
        records.revokeAll.push({ principalId, expectedEpoch, nowMs, event });
        return state.epochOutcome;
      },
      async findByDigest(purpose, digest) {
        calls.push('store:findByDigest');
        if (state.readFailure) return err(state.readFailure);
        const found = state.challenges.get(digestKey(digest));
        return ok(
          found && found.challenge.tokenDigest.purpose() === purpose
            ? found
            : undefined,
        );
      },
      async issueChallenge(record) {
        calls.push('store:issueChallenge');
        records.issue.push(record);
        return state.issueOutcome;
      },
      async verifyEmail(record) {
        calls.push('store:verifyEmail');
        records.verify.push(record);
        return state.verifyOutcome;
      },
      async changePassword(record) {
        calls.push('store:changePassword');
        records.change.push(record);
        return state.passwordOutcome;
      },
      async resetPassword(record) {
        calls.push('store:resetPassword');
        records.reset.push(record);
        return state.passwordOutcome;
      },
      async issueUpgradeTicket() {
        calls.push('store:issueUpgradeTicket');
        return ok('committed' as const);
      },
      async consumeUpgradeTicket() {
        calls.push('store:consumeUpgradeTicket');
        return ok(undefined);
      },
    },
  };
  const principal = (
    id: ID,
    status: Snapshot['status'] = 'active',
  ): Snapshot => ({
    id,
    kind: 'human',
    displayName: 'ada',
    status,
    createdAtMs: T0 - 1000,
    updatedAtMs: T0 - 1000,
    version: 1,
  });
  const credential = (
    id: ID,
    address: string,
    verified = true,
  ): CredentialSnapshot => ({
    principalId: id,
    email: email(address),
    passwordHash: new SecretString('$hash$' + knownPassword),
    passwordVersion: 3,
    createdAtMs: T0 - 1000,
    changedAtMs: T0 - 1000,
    ...(verified ? { verifiedAtMs: T0 - 500 } : {}),
  });
  const seed = (
    opts: { status?: Snapshot['status']; verified?: boolean } = {},
  ) => {
    const id = uuid(0x77);
    const rec: CredentialRecord = {
      principal: principal(id, opts.status),
      credential: credential(id, 'ada@example.com', opts.verified),
      authEpoch: 5,
    };
    state.credentials.set('ada@example.com', rec);
    state.byPrincipal.set(id, rec);
    return rec;
  };
  const challenge = (
    purpose: TokenPurpose,
    opts: { verified?: boolean; consumed?: boolean } = {},
  ) => {
    const rec = seed({ verified: opts.verified });
    const snap: ChallengeSnapshot = {
      id: uuid(0x88),
      principalId: rec.principal.id,
      tokenDigest: digestOf(purpose, 9),
      passwordVersion: 3,
      issuedAtMs: T0 - 100,
      expiresAtMs: T0 + 100,
      ...(opts.consumed ? { consumedAtMs: T0 - 50 } : {}),
    };
    const found: ChallengeRecord = {
      challenge: snap,
      credential: rec.credential,
      principalStatus: rec.principal.status,
      authEpoch: rec.authEpoch,
    };
    state.challenges.set(purpose + ':9', found);
    return { record: found, token: new SecretString('tok-' + purpose + '-9') };
  };
  const caller = (rec: CredentialRecord): AuthenticatedPrincipal => ({
    principalId: rec.principal.id,
    sessionId: uuid(0x99),
    authEpoch: rec.authEpoch,
  });
  return {
    calls,
    clock,
    ids,
    state,
    records,
    ports,
    knownPassword,
    seed,
    challenge,
    caller,
  };
}
const privateStrings = (f: Fakes, extra: string[] = []) => [
  'ada@example.com',
  'example.com',
  f.knownPassword,
  '$hash$',
  'tok-',
  'source-1',
  ...extra,
];
function assertSafe(events: readonly Envelope[], privates: string[]) {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    const text = Buffer.from(e.bytes()).toString('utf8');
    for (const s of privates) expect(text, s).not.toContain(s);
    const wire = JSON.parse(text);
    expect(wire.work.work_id).toBe(uuid(0xa1));
    expect(wire.occurred_at_ms).toBe(T0);
  }
}

describe('configuration', () => {
  it('validates product defaults once', () => {
    expect(validateConfig(DEFAULT_CONFIG).ok).toBe(true);
    expect(DEFAULT_CONFIG.sessionAbsoluteMs).toBe(12 * 3600_000);
    expect(DEFAULT_CONFIG.sessionIdleMs).toBe(30 * 60_000);
    expect(DEFAULT_CONFIG.verificationTtlMs).toBe(24 * 3600_000);
    expect(DEFAULT_CONFIG.resetTtlMs).toBe(15 * 60_000);
    for (const bad of [
      { ...DEFAULT_CONFIG, sessionIdleMs: 0 },
      { ...DEFAULT_CONFIG, resetTtlMs: -1 },
      { ...DEFAULT_CONFIG, sessionAbsoluteMs: 253402300800000 },
      {
        ...DEFAULT_CONFIG,
        sessionIdleMs: DEFAULT_CONFIG.sessionAbsoluteMs + 1,
      },
      { ...DEFAULT_CONFIG, verificationTtlMs: 1.5 },
    ]) {
      const r = validateConfig(bad);
      expect(refused(r).type).toBe('identity.auth_configuration');
    }
    const f = fakes();
    expect(
      refused(Register.create(f.ports, { ...DEFAULT_CONFIG, resetTtlMs: 0 }))
        .type,
    ).toBe('identity.auth_configuration');
  });
});

describe('register (U04)', () => {
  const input = (
    f: Fakes,
    over: Partial<{ email: string; password: string }> = {},
  ) => ({
    email: over.email ?? 'Ada.Lovelace@Example.COM',
    password: new SecretString(over.password ?? 'a brand new passphrase'),
    source: 'source-1',
    work: work(),
  });
  it('creates principal, epoch, credential, challenge and safe event, then mails', async () => {
    const f = fakes();
    const op = value(Register.create(f.ports, DEFAULT_CONFIG));
    const r = value(await op.execute(input(f)));
    expect(r).toEqual({
      accepted: true,
      outcome: 'created',
      mailDelivered: true,
    });
    expect(f.calls).toEqual([
      'admit:register',
      'blocklist',
      'hash',
      'issue:email_verification',
      'store:register',
      'mail:verification',
    ]);
    expect(f.records.limiter).toEqual([
      {
        op: 'register',
        subject: 'ada.lovelace@example.com',
        source: 'source-1',
      },
    ]);
    const rec = f.records.register[0];
    expect(rec.principal).toEqual({
      id: uuid(1),
      kind: 'human',
      displayName: 'ada.lovelace',
      status: 'active',
      createdAtMs: T0,
      updatedAtMs: T0,
      version: 1,
    });
    expect(rec.authEpoch).toBe(1);
    expect(rec.credential.principalId).toBe(uuid(1));
    expect(rec.credential.email.reveal()).toBe('ada.lovelace@example.com');
    expect(rec.credential.passwordHash.reveal()).toBe(
      '$hash$a brand new passphrase',
    );
    expect(rec.credential.passwordVersion).toBe(1);
    expect(rec.credential.createdAtMs).toBe(T0);
    expect(rec.credential.changedAtMs).toBe(T0);
    expect('verifiedAtMs' in rec.credential).toBe(false);
    expect(rec.challenge).toEqual({
      id: uuid(2),
      principalId: uuid(1),
      tokenDigest: rec.challenge.tokenDigest,
      passwordVersion: 1,
      issuedAtMs: T0,
      expiresAtMs: T0 + DEFAULT_CONFIG.verificationTtlMs,
    });
    expect(rec.challenge.tokenDigest.purpose()).toBe('email_verification');
    expect(
      rec.events.map((e) => JSON.parse(Buffer.from(e.bytes()).toString()).type),
    ).toEqual(['identity.principal.registered.v1']);
    expect(rec.events[0].id).toBe(uuid(3));
    expect(
      JSON.parse(Buffer.from(rec.events[0].bytes()).toString()).payload,
    ).toEqual({
      principal_id: uuid(1),
      kind: 'human',
      origin: 'self_registration',
    });
    assertSafe(rec.events, privateStrings(f, ['ada.lovelace', 'brand new']));
    expect(f.records.mail).toEqual([
      {
        kind: 'verification',
        email: 'ada.lovelace@example.com',
        token: 'tok-email_verification-1',
        expiresAtMs: T0 + DEFAULT_CONFIG.verificationTtlMs,
      },
    ]);
  });
  it('truncates the display name to the principal limit', async () => {
    const f = fakes();
    const op = value(Register.create(f.ports, DEFAULT_CONFIG));
    const local = 'a'.repeat(64);
    value(await op.execute(input(f, { email: local + '@example.com' })));
    expect(f.records.register[0].principal.displayName).toBe(local);
  });
  it('duplicate is accepted, replaces nothing and sends no mail', async () => {
    const f = fakes();
    f.state.registerOutcome = ok('duplicate_email');
    const op = value(Register.create(f.ports, DEFAULT_CONFIG));
    const r = value(await op.execute(input(f)));
    expect(r).toEqual({
      accepted: true,
      outcome: 'duplicate_email',
      mailDelivered: false,
    });
    expect(f.calls.at(-1)).toBe('store:register');
    expect(f.records.mail).toEqual([]);
    expect(f.records.register).toHaveLength(1);
  });
  it('refuses malformed inputs, blocklist and rate limits before hashing', async () => {
    const f = fakes();
    const op = value(Register.create(f.ports, DEFAULT_CONFIG));
    expect(refused(await op.execute(input(f, { email: 'nope' }))).type).toBe(
      'identity.email_invalid',
    );
    expect(
      refused(await op.execute(input(f, { password: 'short' }))).type,
    ).toBe('identity.password_invalid');
    f.state.blocklisted.add('a brand new passphrase');
    const b = refused(await op.execute(input(f)));
    expect(b.kind).toBe('invalid');
    expect(b.type).toBe('identity.password_invalid');
    f.state.blocklisted.clear();
    f.state.admission = { permitted: false, retryAfterMs: 1500 };
    const l = refused(await op.execute(input(f)));
    expect(l.kind).toBe('rate_limited');
    expect(l.type).toBe('identity.auth_rate_limited');
    expect(f.calls.filter((c) => c === 'hash')).toEqual([]);
    expect(f.records.register).toEqual([]);
  });
  it('passes dependency failures through and never mails after uncertain or failed commits', async () => {
    const f = fakes();
    const op = value(Register.create(f.ports, DEFAULT_CONFIG));
    f.state.registerOutcome = err(uncertain());
    const u = refused(await op.execute(input(f)));
    expect(u.kind).toBe('timeout');
    expect(u.type).toBe('database.commit_uncertain');
    f.state.registerOutcome = err(down());
    expect(refused(await op.execute(input(f))).type).toBe(
      'postgres.unavailable',
    );
    f.state.registerOutcome = ok('created');
    f.state.limiterFailure = failure('unavailable', 'redis', {
      type: 'redis.unavailable',
    });
    expect(refused(await op.execute(input(f))).type).toBe('redis.unavailable');
    f.state.limiterFailure = undefined;
    f.state.policyFailure = failure('unavailable', 'blocklist', {
      type: 'blocklist.unavailable',
    });
    expect(refused(await op.execute(input(f))).type).toBe(
      'blocklist.unavailable',
    );
    f.state.policyFailure = undefined;
    f.state.hashFailure = failure('unavailable', 'saturated', {
      type: 'identity.hash_saturated',
    });
    expect(refused(await op.execute(input(f))).type).toBe(
      'identity.hash_saturated',
    );
    expect(f.records.mail).toEqual([]);
  });
  it('reports mail failure privately without failing the command', async () => {
    const f = fakes();
    const op = value(Register.create(f.ports, DEFAULT_CONFIG));
    f.state.mailDelivered = false;
    expect(value(await op.execute(input(f))).mailDelivered).toBe(false);
    f.state.mailThrows = true;
    expect(value(await op.execute(input(f))).mailDelivered).toBe(false);
  });
  it('maps clock and ID source failures to a dependency failure', async () => {
    const f = fakes();
    const op = value(Register.create(f.ports, DEFAULT_CONFIG));
    f.clock.set(new Date(-1));
    expect(refused(await op.execute(input(f))).type).toBe(
      'identity.auth_dependency_failed',
    );
    f.clock.set(new Date(T0));
    const short = { ...f.ports, ids: new Sequence([uuid(1)]) };
    const op2 = value(Register.create(short, DEFAULT_CONFIG));
    const d = refused(await op2.execute(input(f)));
    expect(d.kind).toBe('unavailable');
    expect(d.type).toBe('identity.auth_dependency_failed');
    expect(f.records.register).toEqual([]);
  });
});

describe('request verification and reset (U05, U12)', () => {
  const input = (address = 'ada@example.com') => ({
    email: address,
    source: 'source-1',
    work: work(),
  });
  it('issues a replacement verification challenge and mails post-commit', async () => {
    const f = fakes();
    f.seed({ verified: false });
    const op = value(RequestVerification.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute(input()))).toEqual({
      accepted: true,
      outcome: 'issued',
      mailDelivered: true,
    });
    expect(f.calls).toEqual([
      'admit:verification_request',
      'store:findByEmail',
      'issue:email_verification',
      'store:issueChallenge',
      'mail:verification',
    ]);
    const rec = f.records.issue[0];
    expect(rec.expectedPasswordVersion).toBe(3);
    expect(rec.challenge).toEqual({
      id: uuid(1),
      principalId: uuid(0x77),
      tokenDigest: rec.challenge.tokenDigest,
      passwordVersion: 3,
      issuedAtMs: T0,
      expiresAtMs: T0 + DEFAULT_CONFIG.verificationTtlMs,
    });
    expect(f.records.mail[0]).toEqual({
      kind: 'verification',
      email: 'ada@example.com',
      token: 'tok-email_verification-1',
      expiresAtMs: T0 + DEFAULT_CONFIG.verificationTtlMs,
    });
  });
  it('accepts absent, already verified and stale without mail or writes', async () => {
    const f = fakes();
    const op = value(RequestVerification.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute(input('nobody@example.com')))).toEqual({
      accepted: true,
      outcome: 'absent',
      mailDelivered: false,
    });
    f.seed({ verified: true });
    expect(value(await op.execute(input()))).toEqual({
      accepted: true,
      outcome: 'already_verified',
      mailDelivered: false,
    });
    expect(f.records.issue).toEqual([]);
    f.seed({ verified: false });
    f.state.issueOutcome = ok('stale');
    expect(value(await op.execute(input()))).toEqual({
      accepted: true,
      outcome: 'stale',
      mailDelivered: false,
    });
    expect(f.records.mail).toEqual([]);
  });
  it('refuses malformed email and rate limits, passes read and commit failures through', async () => {
    const f = fakes();
    f.seed({ verified: false });
    const op = value(RequestVerification.create(f.ports, DEFAULT_CONFIG));
    expect(refused(await op.execute(input('bad'))).type).toBe(
      'identity.email_invalid',
    );
    f.state.admission = { permitted: false, retryAfterMs: 1 };
    expect(refused(await op.execute(input())).type).toBe(
      'identity.auth_rate_limited',
    );
    f.state.admission = { permitted: true };
    f.state.readFailure = down();
    expect(refused(await op.execute(input())).type).toBe(
      'postgres.unavailable',
    );
    f.state.readFailure = undefined;
    f.state.issueOutcome = err(uncertain());
    expect(refused(await op.execute(input())).type).toBe(
      'database.commit_uncertain',
    );
    expect(f.records.mail).toEqual([]);
  });
  it('accepts a principal that is not active with no challenge and no mail (U05, U12, U17)', async () => {
    for (const kind of ['verification', 'reset'] as const) {
      const f = fakes();
      f.seed({ status: 'suspended', verified: false });
      const op =
        kind === 'reset'
          ? value(RequestReset.create(f.ports, DEFAULT_CONFIG))
          : value(RequestVerification.create(f.ports, DEFAULT_CONFIG));
      expect(value(await op.execute(input())), kind).toEqual({
        accepted: true,
        outcome: 'inactive',
        mailDelivered: false,
      });
      expect(f.records.issue, kind).toEqual([]);
      expect(f.records.mail, kind).toEqual([]);
      expect(f.calls, kind).toEqual([
        kind === 'reset' ? 'admit:reset_request' : 'admit:verification_request',
        'store:findByEmail',
      ]);
    }
  });
  it('reset requests use the reset purpose and lifetime and allow unverified credentials', async () => {
    const f = fakes();
    f.seed({ verified: false });
    const op = value(RequestReset.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute(input()))).toEqual({
      accepted: true,
      outcome: 'issued',
      mailDelivered: true,
    });
    expect(f.calls).toEqual([
      'admit:reset_request',
      'store:findByEmail',
      'issue:password_reset',
      'store:issueChallenge',
      'mail:reset',
    ]);
    expect(f.records.issue[0].challenge.tokenDigest.purpose()).toBe(
      'password_reset',
    );
    expect(f.records.issue[0].challenge.expiresAtMs).toBe(
      T0 + DEFAULT_CONFIG.resetTtlMs,
    );
    expect(f.records.mail[0].kind).toBe('reset');
    expect(value(await op.execute(input('nobody@example.com'))).outcome).toBe(
      'absent',
    );
  });
});

describe('verify email (U06)', () => {
  const input = (token: SecretString, password: string) => ({
    token,
    password: new SecretString(password),
    source: 'source-1',
    work: work(),
  });
  it('consumes the challenge with password proof and commits a safe event', async () => {
    const f = fakes();
    const { token, record } = f.challenge('email_verification', {
      verified: false,
    });
    const op = value(VerifyEmail.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute(input(token, f.knownPassword)))).toEqual({
      verified: true,
      principalId: record.credential.principalId,
    });
    expect(f.calls).toEqual([
      'admit:verify',
      'store:findByDigest',
      'verify',
      'store:verifyEmail',
    ]);
    expect(f.records.limiter[0].op).toBe('verify');
    expect(f.records.limiter[0].subject).not.toContain('tok-');
    const rec = f.records.verify[0];
    expect(rec).toMatchObject({
      challengeId: uuid(0x88),
      principalId: uuid(0x77),
      consumedAtMs: T0,
      expectedPasswordVersion: 3,
    });
    expect(
      JSON.parse(Buffer.from(rec.events[0].bytes()).toString()),
    ).toMatchObject({
      type: 'identity.email.verified.v1',
      payload: { principal_id: uuid(0x77), challenge_id: uuid(0x88) },
    });
    assertSafe(rec.events, privateStrings(f));
  });
  it('already verified credentials still consume idempotently', async () => {
    const f = fakes();
    const { token } = f.challenge('email_verification', { verified: true });
    const op = value(VerifyEmail.create(f.ports, DEFAULT_CONFIG));
    expect(
      value(await op.execute(input(token, f.knownPassword))).verified,
    ).toBe(true);
    expect(f.records.verify).toHaveLength(1);
  });
  it('rejects absent, malformed, wrong password, consumed, expired and stale identically', async () => {
    const f = fakes();
    const { token } = f.challenge('email_verification', { verified: false });
    const op = value(VerifyEmail.create(f.ports, DEFAULT_CONFIG));
    const rejected = async (i: ReturnType<typeof input>) => {
      const e = refused(await op.execute(i));
      expect(e.kind).toBe('unauthenticated');
      expect(e.type).toBe('identity.challenge_rejected');
    };
    await rejected(
      input(new SecretString('tok-email_verification-4'), f.knownPassword),
    );
    await rejected(input(new SecretString('garbage'), f.knownPassword));
    await rejected(
      input(new SecretString('tok-password_reset-9'), f.knownPassword),
    );
    await rejected(input(token, 'wrong password here'));
    expect(f.calls.filter((c) => c === 'verify')).toHaveLength(1);
    expect(f.records.verify).toEqual([]);
    f.clock.set(new Date(T0 + 100));
    await rejected(input(token, f.knownPassword));
    f.clock.set(new Date(T0));
    f.state.verifyOutcome = ok('stale');
    await rejected(input(token, f.knownPassword));
    f.state.verifyOutcome = ok('committed');
    f.challenge('email_verification', { verified: false, consumed: true });
    await rejected(input(token, f.knownPassword));
    expect(refused(await op.execute(input(token, ''))).type).toBe(
      'identity.password_invalid',
    );
  });
  it('passes dependency failures and uncertain commits through', async () => {
    const f = fakes();
    const { token } = f.challenge('email_verification', { verified: false });
    const op = value(VerifyEmail.create(f.ports, DEFAULT_CONFIG));
    f.state.readFailure = down();
    expect(refused(await op.execute(input(token, f.knownPassword))).type).toBe(
      'postgres.unavailable',
    );
    f.state.readFailure = undefined;
    f.state.hashFailure = failure('internal', 'corrupt', {
      type: 'identity.credential_corrupt',
    });
    expect(refused(await op.execute(input(token, f.knownPassword))).type).toBe(
      'identity.credential_corrupt',
    );
    f.state.hashFailure = undefined;
    f.state.verifyOutcome = err(uncertain());
    expect(refused(await op.execute(input(token, f.knownPassword))).type).toBe(
      'database.commit_uncertain',
    );
    f.state.admission = { permitted: false, retryAfterMs: 1 };
    expect(refused(await op.execute(input(token, f.knownPassword))).type).toBe(
      'identity.auth_rate_limited',
    );
  });
});

describe('login (U07)', () => {
  const input = (password: string, address = 'ADA@example.com') => ({
    email: address,
    password: new SecretString(password),
    source: 'source-1',
    work: work(),
  });
  it('issues a fresh session with a safe event after verification', async () => {
    const f = fakes();
    const rec = f.seed();
    const op = value(Login.create(f.ports, DEFAULT_CONFIG));
    const r = value(await op.execute(input(f.knownPassword)));
    expect(f.calls).toEqual([
      'admit:login',
      'store:findByEmail',
      'verify',
      'issue:session',
      'store:commitLogin',
    ]);
    expect(r.sessionId).toBe(uuid(1));
    expect(secretText(r.token)).toBe('tok-session-1');
    expect(r.absoluteExpiresAtMs).toBe(T0 + DEFAULT_CONFIG.sessionAbsoluteMs);
    expect(r.idleExpiresAtMs).toBe(T0 + DEFAULT_CONFIG.sessionIdleMs);
    expect(r.authEpoch).toBe(5);
    expect(r.principal).toEqual({
      id: rec.principal.id,
      kind: 'human',
      displayName: 'ada',
    });
    const login = f.records.login[0];
    expect(login.expectedPasswordVersion).toBe(3);
    expect(login.expectedAuthEpoch).toBe(5);
    expect(login.session).toEqual({
      id: uuid(1),
      principalId: rec.principal.id,
      tokenDigest: login.session.tokenDigest,
      authEpoch: 5,
      issuedAtMs: T0,
      lastSeenAtMs: T0,
      absoluteExpiresAtMs: T0 + DEFAULT_CONFIG.sessionAbsoluteMs,
      idleExpiresAtMs: T0 + DEFAULT_CONFIG.sessionIdleMs,
    });
    expect(login.session.tokenDigest.purpose()).toBe('session');
    expect(
      JSON.parse(Buffer.from(login.events[0].bytes()).toString()),
    ).toMatchObject({
      type: 'identity.session.created.v1',
      payload: {
        principal_id: rec.principal.id,
        session_id: uuid(1),
        auth_epoch: 5,
      },
    });
    assertSafe(login.events, privateStrings(f));
    expect(f.records.limiter[0]).toEqual({
      op: 'login',
      subject: 'ada@example.com',
      source: 'source-1',
    });
  });
  it('rejects unknown, wrong, unverified, suspended and stale with one refusal after comparable work', async () => {
    const f = fakes();
    const op = value(Login.create(f.ports, DEFAULT_CONFIG));
    const rejected = async (i: ReturnType<typeof input>) => {
      const e = refused(await op.execute(i));
      expect(e.kind).toBe('unauthenticated');
      expect(e.type).toBe('identity.credentials_rejected');
    };
    await rejected(input(f.knownPassword, 'nobody@example.com'));
    expect(f.calls).toEqual([
      'admit:login',
      'store:findByEmail',
      'verifyAbsent',
    ]);
    f.calls.length = 0;
    f.seed();
    await rejected(input('wrong password'));
    expect(f.calls).toEqual(['admit:login', 'store:findByEmail', 'verify']);
    f.seed({ verified: false });
    await rejected(input(f.knownPassword));
    f.seed({ status: 'suspended' });
    await rejected(input(f.knownPassword));
    expect(f.calls.filter((c) => c === 'verify')).toHaveLength(3);
    expect(f.records.login).toEqual([]);
    f.seed();
    f.state.loginOutcome = ok('stale');
    await rejected(input(f.knownPassword));
    expect(f.records.login).toHaveLength(1);
  });
  it('distinguishes request shape, rate limits, dependency failures and uncertain commits', async () => {
    const f = fakes();
    f.seed();
    const op = value(Login.create(f.ports, DEFAULT_CONFIG));
    expect(refused(await op.execute(input(f.knownPassword, 'bad'))).type).toBe(
      'identity.email_invalid',
    );
    expect(refused(await op.execute(input(''))).type).toBe(
      'identity.password_invalid',
    );
    f.state.admission = { permitted: false, retryAfterMs: 1 };
    expect(refused(await op.execute(input(f.knownPassword))).type).toBe(
      'identity.auth_rate_limited',
    );
    f.state.admission = { permitted: true };
    f.state.readFailure = down();
    expect(refused(await op.execute(input(f.knownPassword))).type).toBe(
      'postgres.unavailable',
    );
    f.state.readFailure = undefined;
    f.state.hashFailure = failure('timeout', 'queue', {
      type: 'identity.hash_queue_timeout',
    });
    expect(refused(await op.execute(input(f.knownPassword))).type).toBe(
      'identity.hash_queue_timeout',
    );
    f.state.hashFailure = undefined;
    f.state.loginOutcome = err(uncertain());
    const u = refused(await op.execute(input(f.knownPassword)));
    expect(u.type).toBe('database.commit_uncertain');
    expect(u.kind).toBe('timeout');
    expect(f.calls.filter((c) => c === 'verify')).toHaveLength(2);
  });
});

describe('logout and logout-all (U09, U10)', () => {
  it('revokes the caller session idempotently with a safe event', async () => {
    const f = fakes();
    const caller = f.caller(f.seed());
    const op = value(Logout.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute({ caller, work: work() }))).toEqual({
      done: true,
      outcome: 'revoked',
    });
    const rec = f.records.revoke[0];
    expect(rec).toMatchObject({
      sessionId: uuid(0x99),
      principalId: uuid(0x77),
      nowMs: T0,
    });
    expect(JSON.parse(Buffer.from(rec.event.bytes()).toString())).toMatchObject(
      {
        type: 'identity.session.revoked.v1',
        payload: {
          principal_id: uuid(0x77),
          session_id: uuid(0x99),
          reason: 'logout',
        },
      },
    );
    assertSafe([rec.event], privateStrings(f));
    for (const o of ['already_inactive', 'absent'] as const) {
      f.state.revokeOutcome = ok(o);
      expect(value(await op.execute({ caller, work: work() }))).toEqual({
        done: true,
        outcome: o,
      });
    }
    f.state.revokeOutcome = err(uncertain());
    expect(refused(await op.execute({ caller, work: work() })).type).toBe(
      'database.commit_uncertain',
    );
  });
  it('logout-all increments the epoch from the admitted one', async () => {
    const f = fakes();
    const caller = f.caller(f.seed());
    const op = value(LogoutAll.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute({ caller, work: work() }))).toEqual({
      done: true,
      authEpoch: 6,
    });
    const rec = f.records.revokeAll[0];
    expect(rec).toMatchObject({
      principalId: uuid(0x77),
      expectedEpoch: 5,
      nowMs: T0,
    });
    expect(JSON.parse(Buffer.from(rec.event.bytes()).toString())).toMatchObject(
      {
        type: 'identity.sessions.revoked.v1',
        payload: {
          principal_id: uuid(0x77),
          auth_epoch: 6,
          reason: 'logout_all',
        },
      },
    );
    f.state.epochOutcome = ok('stale');
    const s = refused(await op.execute({ caller, work: work() }));
    expect(s.kind).toBe('conflict');
    expect(s.type).toBe('identity.version_conflict');
    expect(
      refused(
        await op.execute({
          caller: { ...caller, authEpoch: 2147483647 },
          work: work(),
        }),
      ).type,
    ).toBe('identity.version_exhausted');
    f.state.epochOutcome = err(down());
    expect(refused(await op.execute({ caller, work: work() })).type).toBe(
      'postgres.unavailable',
    );
  });
});

describe('change password (U11)', () => {
  const input = (
    f: Fakes,
    current: string,
    next = 'a totally new passphrase',
  ) => ({
    caller: f.caller(f.seed()),
    currentPassword: new SecretString(current),
    newPassword: new SecretString(next),
    source: 'source-1',
    work: work(),
  });
  it('verifies the current password, hashes the new one and invalidates all sessions', async () => {
    const f = fakes();
    const op = value(ChangePassword.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute(input(f, f.knownPassword)))).toEqual({
      done: true,
      passwordVersion: 4,
      authEpoch: 6,
      sessionsInvalidated: true,
    });
    expect(f.calls).toEqual([
      'admit:password_change',
      'store:findByPrincipal',
      'verify',
      'blocklist',
      'hash',
      'store:changePassword',
    ]);
    expect(f.records.limiter[0]).toEqual({
      op: 'password_change',
      subject: uuid(0x77),
      source: 'source-1',
    });
    const rec = f.records.change[0];
    expect(rec).toMatchObject({
      principalId: uuid(0x77),
      expectedPasswordVersion: 3,
      expectedAuthEpoch: 5,
      changedAtMs: T0,
    });
    expect(rec.passwordHash.reveal()).toBe('$hash$a totally new passphrase');
    const wires = rec.events.map((e) =>
      JSON.parse(Buffer.from(e.bytes()).toString()),
    );
    expect(wires.map((w) => [w.type, w.payload])).toEqual([
      [
        'identity.password.changed.v1',
        { principal_id: uuid(0x77), password_version: 4, reason: 'change' },
      ],
      [
        'identity.sessions.revoked.v1',
        { principal_id: uuid(0x77), auth_epoch: 6, reason: 'password_change' },
      ],
    ]);
    expect(rec.events.map((e) => e.id)).toEqual([uuid(1), uuid(2)]);
    assertSafe(rec.events, privateStrings(f, ['totally new']));
  });
  it('refuses wrong proof, blocklist, missing credential, stale and shape problems', async () => {
    const f = fakes();
    const op = value(ChangePassword.create(f.ports, DEFAULT_CONFIG));
    const w = refused(await op.execute(input(f, 'wrong')));
    expect(w.kind).toBe('unauthenticated');
    expect(w.type).toBe('identity.credentials_rejected');
    expect(f.calls).not.toContain('hash');
    f.state.blocklisted.add('a totally new passphrase');
    expect(refused(await op.execute(input(f, f.knownPassword))).type).toBe(
      'identity.password_invalid',
    );
    f.state.blocklisted.clear();
    expect(
      refused(await op.execute(input(f, f.knownPassword, 'short'))).type,
    ).toBe('identity.password_invalid');
    expect(refused(await op.execute(input(f, ''))).type).toBe(
      'identity.password_invalid',
    );
    const i = input(f, f.knownPassword);
    f.state.byPrincipal.clear();
    const m = refused(await op.execute(i));
    expect(m.type).toBe('identity.session_rejected');
    f.seed();
    f.state.passwordOutcome = ok('stale');
    const s = refused(await op.execute(input(f, f.knownPassword)));
    expect(s.kind).toBe('conflict');
    expect(s.type).toBe('identity.version_conflict');
    f.state.passwordOutcome = err(uncertain());
    expect(refused(await op.execute(input(f, f.knownPassword))).type).toBe(
      'database.commit_uncertain',
    );
    f.state.admission = { permitted: false, retryAfterMs: 1 };
    expect(refused(await op.execute(input(f, f.knownPassword))).type).toBe(
      'identity.auth_rate_limited',
    );
  });
});

describe('reset password (U13)', () => {
  const input = (token: SecretString, next = 'a totally new passphrase') => ({
    token,
    newPassword: new SecretString(next),
    source: 'source-1',
    work: work(),
  });
  it('consumes the reset challenge, replaces the password, sets verification and invalidates sessions', async () => {
    const f = fakes();
    const { token } = f.challenge('password_reset', { verified: false });
    const op = value(ResetPassword.create(f.ports, DEFAULT_CONFIG));
    expect(value(await op.execute(input(token)))).toEqual({
      done: true,
      principalId: uuid(0x77),
      passwordVersion: 4,
    });
    expect(f.calls).toEqual([
      'admit:reset',
      'store:findByDigest',
      'blocklist',
      'hash',
      'store:resetPassword',
    ]);
    const rec = f.records.reset[0];
    expect(rec).toMatchObject({
      challengeId: uuid(0x88),
      principalId: uuid(0x77),
      consumedAtMs: T0,
      changedAtMs: T0,
      expectedPasswordVersion: 3,
      expectedAuthEpoch: 5,
      setVerified: true,
    });
    expect(rec.passwordHash.reveal()).toBe('$hash$a totally new passphrase');
    const wires = rec.events.map((e) =>
      JSON.parse(Buffer.from(e.bytes()).toString()),
    );
    expect(wires.map((w) => [w.type, w.payload])).toEqual([
      [
        'identity.password.changed.v1',
        { principal_id: uuid(0x77), password_version: 4, reason: 'reset' },
      ],
      [
        'identity.sessions.revoked.v1',
        { principal_id: uuid(0x77), auth_epoch: 6, reason: 'password_reset' },
      ],
    ]);
    assertSafe(rec.events, privateStrings(f, ['totally new']));
    f.challenge('password_reset', { verified: true });
    value(await op.execute(input(token)));
    expect(f.records.reset[1].setVerified).toBe(false);
  });
  it('rejects absent, malformed, wrong purpose, consumed, expired and stale identically and never issues a session', async () => {
    const f = fakes();
    const { token } = f.challenge('password_reset', { verified: false });
    const op = value(ResetPassword.create(f.ports, DEFAULT_CONFIG));
    const rejected = async (t: SecretString) => {
      const e = refused(await op.execute(input(t)));
      expect(e.kind).toBe('unauthenticated');
      expect(e.type).toBe('identity.challenge_rejected');
    };
    await rejected(new SecretString('tok-password_reset-4'));
    await rejected(new SecretString('garbage'));
    await rejected(new SecretString('tok-email_verification-9'));
    f.clock.set(new Date(T0 + 100));
    await rejected(token);
    f.clock.set(new Date(T0));
    expect(f.calls).not.toContain('hash');
    f.state.passwordOutcome = ok('stale');
    await rejected(token);
    f.state.passwordOutcome = ok('committed');
    f.challenge('password_reset', { verified: false, consumed: true });
    await rejected(token);
    expect(f.calls).not.toContain('issue:session');
    expect(refused(await op.execute(input(token, 'short'))).type).toBe(
      'identity.password_invalid',
    );
    f.state.blocklisted.add('a totally new passphrase');
    f.challenge('password_reset', { verified: false });
    expect(refused(await op.execute(input(token))).type).toBe(
      'identity.password_invalid',
    );
  });
  it('passes dependency failures and uncertain commits through', async () => {
    const f = fakes();
    const { token } = f.challenge('password_reset', { verified: false });
    const op = value(ResetPassword.create(f.ports, DEFAULT_CONFIG));
    f.state.readFailure = down();
    expect(refused(await op.execute(input(token))).type).toBe(
      'postgres.unavailable',
    );
    f.state.readFailure = undefined;
    f.state.hashFailure = failure('unavailable', 'saturated', {
      type: 'identity.hash_saturated',
    });
    expect(refused(await op.execute(input(token))).type).toBe(
      'identity.hash_saturated',
    );
    f.state.hashFailure = undefined;
    f.state.passwordOutcome = err(uncertain());
    expect(refused(await op.execute(input(token))).type).toBe(
      'database.commit_uncertain',
    );
    f.state.admission = { permitted: false, retryAfterMs: 1 };
    expect(refused(await op.execute(input(token))).type).toBe(
      'identity.auth_rate_limited',
    );
  });
});
