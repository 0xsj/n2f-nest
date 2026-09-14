import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Envelope } from '../../../../shared/events/index.js';
import { migration as eventsMigration } from '../../../../shared/events/postgres/store.js';
import { Database } from '../../../../shared/postgres/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import {
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Email } from '../../domain/email.js';
import { TokenDigest, type TokenPurpose } from '../../domain/token.js';
import type { Snapshot as PrincipalSnapshot } from '../../domain/principal.js';
import type { CredentialSnapshot } from '../../domain/credential.js';
import type { ChallengeSnapshot } from '../../domain/challenge.js';
import type { SessionSnapshot } from '../../domain/session.js';
import type { RegisterRecord } from '../../app/command/ports.js';
import { Store, migration } from './index.js';

function value<T>(r: Result<T, Failure>): T {
  if (!r.ok) throw Error(r.error.type ?? r.error.kind);
  return r.value;
}
function refused<T>(r: Result<T, Failure>): Failure {
  if (r.ok) throw Error('expected refusal');
  return r.error;
}
let counter = 0;
const nextId = (): ID => {
  counter += 1;
  return value(
    parse('00000000-0000-4000-8000-' + counter.toString(16).padStart(12, '0')),
  );
};
const digestOf = (purpose: TokenPurpose): TokenDigest => {
  counter += 1;
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, counter);
  bytes[31] = purpose.length;
  return value(TokenDigest.parse(purpose, bytes));
};
const work = value(
  Envelope.decode(
    Buffer.from(
      readFileSync(
        new URL(
          '../../../../shared/events/fixtures/envelope.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  ),
).work;
const event = (type: string, payload: Record<string, unknown>) =>
  value(Envelope.create(nextId(), type, 1000, work, payload));
const email = (): Email => {
  counter += 1;
  return value(Email.parse('User.' + counter + '@Example.com'));
};
const HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$gYJZtjEAJqjg26xdLmknq8/bB7MiWPrE9hsYuA+SkIU';
const T0 = 1000;
const registration = (
  login = email(),
  principalId = nextId(),
): RegisterRecord => {
  const principal: PrincipalSnapshot = {
    id: principalId,
    kind: 'human',
    displayName: login.reveal().split('@')[0],
    status: 'active',
    createdAtMs: T0,
    updatedAtMs: T0,
    version: 1,
  };
  const credential: CredentialSnapshot = {
    principalId,
    email: login,
    passwordHash: new SecretString(HASH),
    passwordVersion: 1,
    createdAtMs: T0,
    changedAtMs: T0,
  };
  const challenge: ChallengeSnapshot = {
    id: nextId(),
    principalId,
    tokenDigest: digestOf('email_verification'),
    passwordVersion: 1,
    issuedAtMs: T0,
    expiresAtMs: T0 + 86_400_000,
  };
  return {
    principal,
    authEpoch: 1,
    credential,
    challenge,
    events: [
      event('identity.principal.registered.v1', {
        principal_id: principalId,
        kind: 'human',
        origin: 'self_registration',
      }),
    ],
  };
};
const session = (principalId: ID, epoch = 1, issued = T0): SessionSnapshot => ({
  id: nextId(),
  principalId,
  tokenDigest: digestOf('session'),
  authEpoch: epoch,
  issuedAtMs: issued,
  lastSeenAtMs: issued,
  absoluteExpiresAtMs: issued + 43_200_000,
  idleExpiresAtMs: issued + 1_800_000,
});
const url = process.env.N2F_TEST_DATABASE_URL;

describe.skipIf(!url)('identity PostgreSQL store', () => {
  let db: Database;
  let store: Store;
  const sql = async <T extends Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> =>
    value(
      await db.transaction(async (tx) =>
        ok((await tx.query<T>(text, params)).rows),
      ),
    );
  const count = async (text: string, params: unknown[] = []) =>
    Number((await sql<{ c: string }>(text, params))[0].c);
  /** Registers and verifies a login so sessions can be issued. */
  const verified = async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    expect(
      value(
        await store.verifyEmail({
          challengeId: r.challenge.id,
          principalId: r.principal.id,
          consumedAtMs: T0 + 5,
          expectedPasswordVersion: 1,
          events: [
            event('identity.email.verified.v1', {
              principal_id: r.principal.id,
              challenge_id: r.challenge.id,
            }),
          ],
        }),
      ),
    ).toBe('committed');
    return r;
  };
  const login = async (r: RegisterRecord, epoch = 1, issued = T0 + 10) => {
    const s = session(r.principal.id, epoch, issued);
    expect(
      value(
        await store.commitLogin({
          session: s,
          expectedPasswordVersion: 1,
          expectedAuthEpoch: epoch,
          events: [
            event('identity.session.created.v1', {
              principal_id: r.principal.id,
              session_id: s.id,
              auth_epoch: epoch,
            }),
          ],
        }),
      ),
    ).toBe('committed');
    return s;
  };
  /** Pre-inserts a conflicting outbox row so the mutation's enqueue must fail and roll back. */
  const poison = async (e: Envelope) => {
    const other = value(
      Envelope.create(e.id, 'identity.poison.v1', 1, work, { other: true }),
    );
    await sql(
      'INSERT INTO public.n2f_outbox(event_id, envelope) VALUES ($1::uuid, $2)',
      [e.id, Buffer.from(other.bytes()).toString()],
    );
  };

  beforeAll(async () => {
    db = value(
      await Database.open({
        url: new SecretString(url!),
        maxConnections: 12,
        timeoutMs: 5000,
      }),
    );
    value(await db.migrate([eventsMigration(1), migration(2)]));
    value(await db.migrate([eventsMigration(1), migration(2)]));
    store = new Store(db);
  });
  afterAll(async () => {
    if (db) await db.close(2000);
  });

  it('S06 register round trip restores every record, including absent timestamps', async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    const byEmail = value(await store.findByEmail(r.credential.email));
    expect(byEmail).toBeDefined();
    expect(byEmail!.principal).toEqual(r.principal);
    expect(byEmail!.authEpoch).toBe(1);
    expect(byEmail!.credential.email.reveal()).toBe(
      r.credential.email.reveal(),
    );
    expect(byEmail!.credential.passwordHash.reveal()).toBe(HASH);
    expect(byEmail!.credential.passwordVersion).toBe(1);
    expect(Object.hasOwn(byEmail!.credential, 'verifiedAtMs')).toBe(false);
    expect(
      value(await store.findByPrincipal(r.principal.id))!.principal,
    ).toEqual(r.principal);
    const found = value(
      await store.findByDigest('email_verification', r.challenge.tokenDigest),
    );
    expect(found).toBeDefined();
    expect(found!.challenge.id).toBe(r.challenge.id);
    expect(found!.challenge.tokenDigest.bytes()).toEqual(
      r.challenge.tokenDigest.bytes(),
    );
    expect(Object.hasOwn(found!.challenge, 'consumedAtMs')).toBe(false);
    expect(Object.hasOwn(found!.challenge, 'invalidatedAtMs')).toBe(false);
    expect(found!.principalStatus).toBe('active');
    expect(found!.authEpoch).toBe(1);
    expect(value(await store.findByEmail(email()))).toBeUndefined();
    expect(value(await store.findByPrincipal(nextId()))).toBeUndefined();
    expect(
      value(
        await store.findByDigest('password_reset', r.challenge.tokenDigest),
      ),
    ).toBeUndefined();
    const rows = await sql<{ envelope: string }>(
      'SELECT envelope FROM public.n2f_outbox WHERE event_id=$1::uuid',
      [r.events[0].id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].envelope).not.toContain(r.credential.email.reveal());
    expect(rows[0].envelope).not.toContain('argon2id');
  });

  it('S06 duplicate email rolls back completely', async () => {
    const first = registration();
    expect(value(await store.register(first))).toBe('created');
    const second = registration(first.credential.email);
    expect(value(await store.register(second))).toBe('duplicate_email');
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_identity_principals WHERE id=$1::uuid',
        [second.principal.id],
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_identity_challenges WHERE id=$1::uuid',
        [second.challenge.id],
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_outbox WHERE event_id=$1::uuid',
        [second.events[0].id],
      ),
    ).toBe(0);
    expect(
      value(await store.findByEmail(first.credential.email))!.principal.id,
    ).toBe(first.principal.id);
  });

  it('S06 concurrent registrations of one email yield exactly one created', async () => {
    const login = email();
    const records = Array.from({ length: 8 }, () => registration(login));
    const outcomes = await Promise.all(records.map((r) => store.register(r)));
    const created = outcomes.filter((o) => o.ok && o.value === 'created');
    expect(created).toHaveLength(1);
    expect(
      outcomes.every(
        (o) => o.ok && (o.value === 'created' || o.value === 'duplicate_email'),
      ),
    ).toBe(true);
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_identity_credentials WHERE canonical_email=$1',
        [login.reveal()],
      ),
    ).toBe(1);
  });

  it('S07 commitLogin is stale for unverified, suspended, version and epoch mismatches', async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    const attempt = (s: SessionSnapshot, version = 1, epoch = 1) =>
      store.commitLogin({
        session: s,
        expectedPasswordVersion: version,
        expectedAuthEpoch: epoch,
        events: [
          event('identity.session.created.v1', {
            principal_id: r.principal.id,
            session_id: s.id,
            auth_epoch: epoch,
          }),
        ],
      });
    expect(value(await attempt(session(r.principal.id)))).toBe('stale');
    expect(
      value(
        await store.verifyEmail({
          challengeId: r.challenge.id,
          principalId: r.principal.id,
          consumedAtMs: T0 + 1,
          expectedPasswordVersion: 1,
          events: [
            event('identity.email.verified.v1', {
              principal_id: r.principal.id,
              challenge_id: r.challenge.id,
            }),
          ],
        }),
      ),
    ).toBe('committed');
    expect(value(await attempt(session(r.principal.id), 2, 1))).toBe('stale');
    expect(value(await attempt(session(r.principal.id), 1, 2))).toBe('stale');
    const s = session(r.principal.id);
    expect(value(await attempt(s))).toBe('committed');
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_identity_sessions WHERE principal_id=$1::uuid',
        [r.principal.id],
      ),
    ).toBe(1);
    await sql(
      "UPDATE public.n2f_identity_principals SET status='suspended', version=2 WHERE id=$1::uuid",
      [r.principal.id],
    );
    expect(value(await attempt(session(r.principal.id)))).toBe('stale');
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_identity_sessions WHERE principal_id=$1::uuid',
        [r.principal.id],
      ),
    ).toBe(1);
  });

  it('S08 resolve admits, extends idle expiry, latches expiry and refuses backward time', async () => {
    const r = await verified();
    const s = await login(r);
    const admitted = value(
      await store.resolve(s.tokenDigest, s.issuedAtMs + 100, 60_000),
    );
    expect(admitted).toEqual({
      outcome: 'admitted',
      principalId: r.principal.id,
      sessionId: s.id,
      authEpoch: 1,
    });
    const row = () =>
      sql<{
        last_seen_at_ms: string;
        idle_expires_at_ms: string;
        revoked_at_ms: string | null;
      }>(
        'SELECT last_seen_at_ms, idle_expires_at_ms, revoked_at_ms FROM public.n2f_identity_sessions WHERE id=$1::uuid',
        [s.id],
      );
    let [state] = await row();
    expect(Number(state.last_seen_at_ms)).toBe(s.issuedAtMs + 100);
    expect(Number(state.idle_expires_at_ms)).toBe(s.issuedAtMs + 100 + 60_000);
    expect(
      value(await store.resolve(s.tokenDigest, s.issuedAtMs + 50, 60_000)),
    ).toEqual({ outcome: 'rejected' });
    [state] = await row();
    expect(Number(state.last_seen_at_ms)).toBe(s.issuedAtMs + 100);
    expect(state.revoked_at_ms).toBeNull();
    const idle = Number(state.idle_expires_at_ms);
    expect(value(await store.resolve(s.tokenDigest, idle, 60_000))).toEqual({
      outcome: 'rejected',
    });
    [state] = await row();
    expect(Number(state.revoked_at_ms)).toBe(idle);
    expect(value(await store.resolve(s.tokenDigest, idle + 1, 60_000))).toEqual(
      { outcome: 'rejected' },
    );
    expect(value(await store.resolve(digestOf('session'), T0, 60_000))).toEqual(
      { outcome: 'absent' },
    );
  });

  it('S08 resolve observes a committed revocation and an epoch change without writing', async () => {
    const r = await verified();
    const s = await login(r);
    expect(
      value(
        await store.revokeSession(
          s.id,
          r.principal.id,
          s.issuedAtMs + 5,
          event('identity.session.revoked.v1', {
            principal_id: r.principal.id,
            session_id: s.id,
            reason: 'logout',
          }),
        ),
      ),
    ).toBe('revoked');
    expect(
      value(await store.resolve(s.tokenDigest, s.issuedAtMs + 10, 60_000)),
    ).toEqual({ outcome: 'rejected' });
    const t = await login(r);
    expect(
      value(
        await store.revokeAll(
          r.principal.id,
          1,
          t.issuedAtMs + 5,
          event('identity.sessions.revoked.v1', {
            principal_id: r.principal.id,
            auth_epoch: 2,
            reason: 'logout_all',
          }),
        ),
      ),
    ).toBe('committed');
    expect(
      value(await store.resolve(t.tokenDigest, t.issuedAtMs + 10, 60_000)),
    ).toEqual({ outcome: 'rejected' });
    const [state] = await sql<{
      last_seen_at_ms: string;
      revoked_at_ms: string | null;
    }>(
      'SELECT last_seen_at_ms, revoked_at_ms FROM public.n2f_identity_sessions WHERE id=$1::uuid',
      [t.id],
    );
    expect(Number(state.last_seen_at_ms)).toBe(t.issuedAtMs);
    expect(state.revoked_at_ms).toBeNull();
    const u = await login(r, 2);
    expect(
      value(await store.resolve(u.tokenDigest, u.issuedAtMs + 10, 60_000))
        .outcome,
    ).toBe('admitted');
    await sql(
      "UPDATE public.n2f_identity_principals SET status='suspended', version=2 WHERE id=$1::uuid",
      [r.principal.id],
    );
    expect(
      value(await store.resolve(u.tokenDigest, u.issuedAtMs + 20, 60_000)),
    ).toEqual({ outcome: 'rejected' });
  });

  it('S09 revokeSession is idempotent, principal-scoped and allowed after expiry', async () => {
    const r = await verified();
    const s = await login(r);
    const revoked = event('identity.session.revoked.v1', {
      principal_id: r.principal.id,
      session_id: s.id,
      reason: 'logout',
    });
    expect(
      value(
        await store.revokeSession(s.id, nextId(), s.issuedAtMs + 1, revoked),
      ),
    ).toBe('absent');
    expect(
      value(
        await store.revokeSession(
          nextId(),
          r.principal.id,
          s.issuedAtMs + 1,
          revoked,
        ),
      ),
    ).toBe('absent');
    expect(
      value(
        await store.revokeSession(
          s.id,
          r.principal.id,
          s.issuedAtMs + 7,
          revoked,
        ),
      ),
    ).toBe('revoked');
    const again = event('identity.session.revoked.v1', {
      principal_id: r.principal.id,
      session_id: s.id,
      reason: 'logout',
    });
    expect(
      value(
        await store.revokeSession(
          s.id,
          r.principal.id,
          s.issuedAtMs + 9,
          again,
        ),
      ),
    ).toBe('already_inactive');
    const [row] = await sql<{ revoked_at_ms: string }>(
      'SELECT revoked_at_ms FROM public.n2f_identity_sessions WHERE id=$1::uuid',
      [s.id],
    );
    expect(Number(row.revoked_at_ms)).toBe(s.issuedAtMs + 7);
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_outbox WHERE event_id=$1::uuid',
        [revoked.id],
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_outbox WHERE event_id=$1::uuid',
        [again.id],
      ),
    ).toBe(0);
    const expired = await login(r);
    expect(
      value(
        await store.revokeSession(
          expired.id,
          r.principal.id,
          expired.absoluteExpiresAtMs + 1,
          event('identity.session.revoked.v1', {
            principal_id: r.principal.id,
            session_id: expired.id,
            reason: 'logout',
          }),
        ),
      ),
    ).toBe('revoked');
  });

  it('S10 revokeAll guards the expected epoch and increments through the domain', async () => {
    const r = await verified();
    const ev = () =>
      event('identity.sessions.revoked.v1', {
        principal_id: r.principal.id,
        auth_epoch: 2,
        reason: 'logout_all',
      });
    expect(value(await store.revokeAll(r.principal.id, 2, T0 + 1, ev()))).toBe(
      'stale',
    );
    expect(value(await store.revokeAll(nextId(), 1, T0 + 1, ev()))).toBe(
      'stale',
    );
    expect(value(await store.revokeAll(r.principal.id, 1, T0 + 1, ev()))).toBe(
      'committed',
    );
    expect(value(await store.findByPrincipal(r.principal.id))!.authEpoch).toBe(
      2,
    );
  });

  it('S11 issueChallenge guards the version and invalidates outstanding challenges including expired ones', async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    await sql(
      'UPDATE public.n2f_identity_challenges SET expires_at_ms=$2 WHERE id=$1::uuid',
      [r.challenge.id, T0 + 1],
    );
    const fresh = (issued: number): ChallengeSnapshot => ({
      id: nextId(),
      principalId: r.principal.id,
      tokenDigest: digestOf('email_verification'),
      passwordVersion: 1,
      issuedAtMs: issued,
      expiresAtMs: issued + 1000,
    });
    expect(
      value(
        await store.issueChallenge({
          challenge: fresh(T0 + 5),
          expectedPasswordVersion: 2,
        }),
      ),
    ).toBe('stale');
    const replacement = fresh(T0 + 5);
    expect(
      value(
        await store.issueChallenge({
          challenge: replacement,
          expectedPasswordVersion: 1,
        }),
      ),
    ).toBe('issued');
    const [old] = await sql<{ invalidated_at_ms: string | null }>(
      'SELECT invalidated_at_ms FROM public.n2f_identity_challenges WHERE id=$1::uuid',
      [r.challenge.id],
    );
    expect(Number(old.invalidated_at_ms)).toBe(T0 + 5);
    expect(
      await count(
        "SELECT count(*) c FROM public.n2f_identity_challenges WHERE principal_id=$1::uuid AND purpose='email_verification' AND consumed_at_ms IS NULL AND invalidated_at_ms IS NULL",
        [r.principal.id],
      ),
    ).toBe(1);
    const reset: ChallengeSnapshot = {
      ...fresh(T0 + 6),
      tokenDigest: digestOf('password_reset'),
    };
    expect(
      value(
        await store.issueChallenge({
          challenge: reset,
          expectedPasswordVersion: 1,
        }),
      ),
    ).toBe('issued');
    expect(
      value(
        await store.findByDigest('email_verification', replacement.tokenDigest),
      )!.challenge.id,
    ).toBe(replacement.id);
    expect(
      value(await store.findByDigest('password_reset', reset.tokenDigest))!
        .challenge.id,
    ).toBe(reset.id);
  });

  it('S12 verifyEmail: stale version, exactly one of eight concurrent consumers, replay stale', async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    const attempt = (version = 1) =>
      store.verifyEmail({
        challengeId: r.challenge.id,
        principalId: r.principal.id,
        consumedAtMs: T0 + 3,
        expectedPasswordVersion: version,
        events: [
          event('identity.email.verified.v1', {
            principal_id: r.principal.id,
            challenge_id: r.challenge.id,
          }),
        ],
      });
    expect(value(await attempt(2))).toBe('stale');
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => attempt()),
    );
    expect(
      outcomes.filter((o) => o.ok && o.value === 'committed'),
    ).toHaveLength(1);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(value(await attempt())).toBe('stale');
    const found = value(
      await store.findByDigest('email_verification', r.challenge.tokenDigest),
    )!;
    expect(found.challenge.consumedAtMs).toBe(T0 + 3);
    expect(found.credential.verifiedAtMs).toBe(T0 + 3);
    expect(
      await count(
        "SELECT count(*) c FROM public.n2f_outbox WHERE envelope LIKE '%identity.email.verified.v1%' AND envelope LIKE '%' || $1 || '%'",
        [r.challenge.id],
      ),
    ).toBe(1);
  });

  it('S13 changePassword bumps version and epoch, invalidates challenges and rejects earlier sessions', async () => {
    const r = await verified();
    const s = await login(r);
    const outstanding: ChallengeSnapshot = {
      id: nextId(),
      principalId: r.principal.id,
      tokenDigest: digestOf('password_reset'),
      passwordVersion: 1,
      issuedAtMs: T0 + 20,
      expiresAtMs: T0 + 900_000,
    };
    expect(
      value(
        await store.issueChallenge({
          challenge: outstanding,
          expectedPasswordVersion: 1,
        }),
      ),
    ).toBe('issued');
    const change = (version: number, epoch: number) =>
      store.changePassword({
        principalId: r.principal.id,
        passwordHash: new SecretString(HASH + 'x'),
        expectedPasswordVersion: version,
        expectedAuthEpoch: epoch,
        changedAtMs: T0 + 30,
        events: [
          event('identity.password.changed.v1', {
            principal_id: r.principal.id,
            password_version: 2,
            reason: 'change',
          }),
          event('identity.sessions.revoked.v1', {
            principal_id: r.principal.id,
            auth_epoch: 2,
            reason: 'password_change',
          }),
        ],
      });
    expect(value(await change(2, 1))).toBe('stale');
    expect(value(await change(1, 2))).toBe('stale');
    expect(value(await change(1, 1))).toBe('committed');
    const rec = value(await store.findByPrincipal(r.principal.id))!;
    expect(rec.authEpoch).toBe(2);
    expect(rec.credential.passwordVersion).toBe(2);
    expect(rec.credential.changedAtMs).toBe(T0 + 30);
    expect(rec.credential.passwordHash.reveal()).toBe(HASH + 'x');
    expect(
      value(await store.resolve(s.tokenDigest, s.issuedAtMs + 100, 60_000)),
    ).toEqual({ outcome: 'rejected' });
    const [c] = await sql<{ invalidated_at_ms: string | null }>(
      'SELECT invalidated_at_ms FROM public.n2f_identity_challenges WHERE id=$1::uuid',
      [outstanding.id],
    );
    expect(Number(c.invalidated_at_ms)).toBe(T0 + 30);
  });

  it('S14 resetPassword consumes the challenge once and sets verification when asked', async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    const reset: ChallengeSnapshot = {
      id: nextId(),
      principalId: r.principal.id,
      tokenDigest: digestOf('password_reset'),
      passwordVersion: 1,
      issuedAtMs: T0 + 20,
      expiresAtMs: T0 + 900_000,
    };
    expect(
      value(
        await store.issueChallenge({
          challenge: reset,
          expectedPasswordVersion: 1,
        }),
      ),
    ).toBe('issued');
    const attempt = (version = 1, epoch = 1) =>
      store.resetPassword({
        challengeId: reset.id,
        principalId: r.principal.id,
        passwordHash: new SecretString(HASH + 'y'),
        consumedAtMs: T0 + 40,
        changedAtMs: T0 + 40,
        expectedPasswordVersion: version,
        expectedAuthEpoch: epoch,
        setVerified: true,
        events: [
          event('identity.password.changed.v1', {
            principal_id: r.principal.id,
            password_version: 2,
            reason: 'reset',
          }),
        ],
      });
    expect(value(await attempt(2, 1))).toBe('stale');
    expect(value(await attempt(1, 1))).toBe('committed');
    expect(value(await attempt(2, 2))).toBe('stale');
    const rec = value(await store.findByPrincipal(r.principal.id))!;
    expect(rec.credential.verifiedAtMs).toBe(T0 + 40);
    expect(rec.credential.passwordVersion).toBe(2);
    expect(rec.authEpoch).toBe(2);
    const found = value(
      await store.findByDigest('password_reset', reset.tokenDigest),
    )!;
    expect(found.challenge.consumedAtMs).toBe(T0 + 40);
    const [orig] = await sql<{ invalidated_at_ms: string | null }>(
      'SELECT invalidated_at_ms FROM public.n2f_identity_challenges WHERE id=$1::uuid',
      [r.challenge.id],
    );
    expect(Number(orig.invalidated_at_ms)).toBe(T0 + 40);
  });

  it('S15 every mutation rolls back completely when its enqueue fails', async () => {
    const r = registration();
    await poison(r.events[0]);
    const failed = refused(await store.register(r));
    expect(failed.type).toBe('events.id_reused');
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_identity_principals WHERE id=$1::uuid',
        [r.principal.id],
      ),
    ).toBe(0);
    const v = await verified();
    const s = session(v.principal.id);
    const created = event('identity.session.created.v1', {
      principal_id: v.principal.id,
      session_id: s.id,
      auth_epoch: 1,
    });
    await poison(created);
    refused(
      await store.commitLogin({
        session: s,
        expectedPasswordVersion: 1,
        expectedAuthEpoch: 1,
        events: [created],
      }),
    );
    expect(
      await count(
        'SELECT count(*) c FROM public.n2f_identity_sessions WHERE id=$1::uuid',
        [s.id],
      ),
    ).toBe(0);
    const live = await login(v);
    const revoked = event('identity.session.revoked.v1', {
      principal_id: v.principal.id,
      session_id: live.id,
      reason: 'logout',
    });
    await poison(revoked);
    refused(
      await store.revokeSession(
        live.id,
        v.principal.id,
        live.issuedAtMs + 1,
        revoked,
      ),
    );
    expect(
      (
        await sql<{ revoked_at_ms: string | null }>(
          'SELECT revoked_at_ms FROM public.n2f_identity_sessions WHERE id=$1::uuid',
          [live.id],
        )
      )[0].revoked_at_ms,
    ).toBeNull();
    const all = event('identity.sessions.revoked.v1', {
      principal_id: v.principal.id,
      auth_epoch: 2,
      reason: 'logout_all',
    });
    await poison(all);
    refused(await store.revokeAll(v.principal.id, 1, T0 + 1, all));
    expect(value(await store.findByPrincipal(v.principal.id))!.authEpoch).toBe(
      1,
    );
    const u = registration();
    expect(value(await store.register(u))).toBe('created');
    const ver = event('identity.email.verified.v1', {
      principal_id: u.principal.id,
      challenge_id: u.challenge.id,
    });
    await poison(ver);
    refused(
      await store.verifyEmail({
        challengeId: u.challenge.id,
        principalId: u.principal.id,
        consumedAtMs: T0 + 3,
        expectedPasswordVersion: 1,
        events: [ver],
      }),
    );
    const c1 = value(
      await store.findByDigest('email_verification', u.challenge.tokenDigest),
    )!;
    expect(Object.hasOwn(c1.challenge, 'consumedAtMs')).toBe(false);
    expect(Object.hasOwn(c1.credential, 'verifiedAtMs')).toBe(false);
    const chg = event('identity.password.changed.v1', {
      principal_id: v.principal.id,
      password_version: 2,
      reason: 'change',
    });
    await poison(chg);
    refused(
      await store.changePassword({
        principalId: v.principal.id,
        passwordHash: new SecretString(HASH + 'z'),
        expectedPasswordVersion: 1,
        expectedAuthEpoch: 1,
        changedAtMs: T0 + 50,
        events: [chg],
      }),
    );
    expect(
      value(await store.findByPrincipal(v.principal.id))!.credential
        .passwordVersion,
    ).toBe(1);
    const reset: ChallengeSnapshot = {
      id: nextId(),
      principalId: u.principal.id,
      tokenDigest: digestOf('password_reset'),
      passwordVersion: 1,
      issuedAtMs: T0 + 20,
      expiresAtMs: T0 + 900_000,
    };
    expect(
      value(
        await store.issueChallenge({
          challenge: reset,
          expectedPasswordVersion: 1,
        }),
      ),
    ).toBe('issued');
    const rst = event('identity.password.changed.v1', {
      principal_id: u.principal.id,
      password_version: 2,
      reason: 'reset',
    });
    await poison(rst);
    refused(
      await store.resetPassword({
        challengeId: reset.id,
        principalId: u.principal.id,
        passwordHash: new SecretString(HASH + 'w'),
        consumedAtMs: T0 + 60,
        changedAtMs: T0 + 60,
        expectedPasswordVersion: 1,
        expectedAuthEpoch: 1,
        setVerified: true,
        events: [rst],
      }),
    );
    const c2 = value(
      await store.findByDigest('password_reset', reset.tokenDigest),
    )!;
    expect(Object.hasOwn(c2.challenge, 'consumedAtMs')).toBe(false);
    expect(
      value(await store.findByPrincipal(u.principal.id))!.credential
        .passwordVersion,
    ).toBe(1);
  });

  it('S05 a stored row the domain refuses is reported as corruption, never absent or stale', async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    await sql(
      'UPDATE public.n2f_identity_credentials SET canonical_email=upper(canonical_email) WHERE principal_id=$1::uuid',
      [r.principal.id],
    );
    const failed = refused(await store.findByPrincipal(r.principal.id));
    expect(failed.kind).toBe('internal');
    expect(failed.type).toBe('identity.record_corrupt');
    expect(failed.fields?.domain_type).toBe('identity.credential_invalid');
    const stale = refused(
      await store.commitLogin({
        session: session(r.principal.id),
        expectedPasswordVersion: 1,
        expectedAuthEpoch: 1,
        events: [],
      }),
    );
    expect(stale.type).toBe('identity.record_corrupt');
  });

  it('S03 pg types and the database URL never appear in a failure', async () => {
    const r = registration();
    expect(value(await store.register(r))).toBe('created');
    const failed = refused(
      await store.register(registration(email(), r.principal.id)),
    );
    expect(failed.type).toBe('database.conflict');
    expect(JSON.stringify(failed)).not.toContain('n2f_identity');
    expect(JSON.stringify(failed)).not.toContain(url!);
  });
});
