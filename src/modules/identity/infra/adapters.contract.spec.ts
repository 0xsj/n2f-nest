import { describe, expect, it } from 'vitest';
import { SecretString } from '../../../shared/secret/index.js';
import {
  event,
  newId,
  postgresContract,
  value,
  work,
} from '../../../../test/support/adapter-contract.js';
import type {
  ActiveSessionReader,
  CurrentSessionReader,
  IdentityReader,
  RegistrationWriter,
  SessionActivityWriter,
  SessionEviction,
  SessionPruner,
  SessionRevocationWriter,
  SessionWriter,
  VerificationChallengeReader,
  VerificationChallengeWriter,
  VerificationWriter,
} from '../app/ports/index.js';
import {
  Credential,
  Identity,
  Session,
  VerificationChallenge,
} from '../domain/index.js';
import type { ID } from '../../../shared/id/index.js';
import { digestToken } from './in-memory/crypto.js';
import {
  InMemoryActiveSessionReader,
  InMemorySessionActivityWriter,
  InMemorySessionPruner,
  InMemoryCurrentSessionReader,
  InMemoryIdentityReader,
  InMemoryIdentityStore,
  InMemoryRegistrationWriter,
  InMemorySessionRevocationWriter,
  InMemorySessionWriter,
  InMemoryVerificationChallengeReader,
  InMemoryVerificationChallengeWriter,
  InMemoryVerificationWriter,
} from './in-memory/index.js';
import {
  PostgresActiveSessionReader,
  PostgresSessionActivityWriter,
  PostgresSessionPruner,
  PostgresCurrentSessionReader,
  PostgresIdentityReader,
  PostgresRegistrationWriter,
  PostgresSessionRevocationWriter,
  PostgresSessionWriter,
  PostgresVerificationChallengeReader,
  PostgresVerificationChallengeWriter,
  PostgresVerificationWriter,
} from './postgres/index.js';

/**
 * One behavioral contract for every Identity storage adapter. The in-memory
 * run always executes; the PostgreSQL run needs a disposable database.
 */
type Adapters = Readonly<{
  registration: RegistrationWriter;
  identities: IdentityReader;
  challengeWriter: VerificationChallengeWriter;
  challenges: VerificationChallengeReader;
  verification: VerificationWriter;
  sessionWriter: SessionWriter;
  sessions: CurrentSessionReader;
  revocation: SessionRevocationWriter;
  activity: SessionActivityWriter;
  active: ActiveSessionReader;
  pruner: SessionPruner;
}>;

const SECOND = 1000;

function contract(name: string, adapters: () => Adapters) {
  describe(`${name} Identity adapters`, () => {
    async function register(email = `contract-${newId()}@example.com`) {
      const { registration } = adapters();
      const createdAt = new Date(Date.now() - 60 * SECOND);
      const identity = value(Identity.register({ id: newId(), createdAt }));
      const credential = value(
        Credential.createEmailPassword({
          id: newId(),
          identityId: identity.id,
          email,
          createdAt,
        }),
      );
      const context = work('identity.register');
      const result = await registration.commit({
        identity,
        credential,
        passwordHash: new SecretString('not-a-real-hash'),
        event: event('identity.registered.v1', context, { identity_id: identity.id }),
        work: context,
      });
      return { identity, email, result };
    }

    it('reports a taken email as identity.email_taken', async () => {
      const first = await register();
      expect(first.result.ok).toBe(true);

      const duplicate = await register(first.email);

      expect(duplicate.result).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'identity.email_taken' },
      });
    });

    it('lets only one of two verifications that read the same state commit', async () => {
      const a = adapters();
      const { identity } = await register();
      const issuedAt = new Date(Date.now() - 30 * SECOND);
      const challenge = value(
        VerificationChallenge.issue({
          id: newId(),
          identityId: identity.id,
          purpose: 'email_verification',
          issuedAt,
          expiresAt: new Date(issuedAt.getTime() + 3600 * SECOND),
        }),
      );
      const issueWork = work('identity.verification-challenge.issue');
      value(
        await a.challengeWriter.commit({
          challenge,
          tokenDigest: new SecretString(`digest-${challenge.id}`),
          event: event('identity.verification_challenge_issued.v1', issueWork, {
            identity_id: identity.id,
          }),
          work: issueWork,
        }),
      );

      // Both operations read the same stored versions before either writes.
      const loadedIdentity = value(await a.identities.find(identity.id))!;
      const loadedChallenge = value(await a.challenges.find(challenge.id))!.challenge;
      const at = new Date();
      const attempt = () => {
        const context = work('identity.verify');
        return a.verification.commit({
          identity: value(loadedIdentity.verify(at)),
          challenge: value(loadedChallenge.consume(at)),
          event: event('identity.verified.v1', context, { identity_id: identity.id }),
          work: context,
        });
      };

      const first = await attempt();
      const second = await attempt();

      expect(first.ok).toBe(true);
      expect(second).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'identity.stale_write' },
      });
      const stored = value(await a.identities.find(identity.id))!;
      expect(stored.status).toBe('active');
      expect(stored.version).toBe(loadedIdentity.version + 1);
    });

    it('lets only one of two revocations that read the same session commit', async () => {
      const a = adapters();
      const { identity } = await register();
      const createdAt = new Date(Date.now() - 10 * SECOND);
      const token = new SecretString(`token-${newId()}`);
      const session = value(
        Session.create({
          id: newId(),
          identityId: identity.id,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 3600 * SECOND),
        }),
      );
      const loginWork = work('identity.login');
      value(
        await a.sessionWriter.commit({
          session,
          tokenDigest: digestToken(token),
          event: event('identity.session_started.v1', loginWork, {
            session_id: session.id,
          }),
          evicted: [],
          work: loginWork,
        }),
      );

      const loaded = value(await a.sessions.findByToken(token))!;
      const at = new Date();
      const attempt = () => {
        const context = work('identity.logout');
        return a.revocation.commit({
          session: value(loaded.revoke(at)),
          event: event('identity.session_revoked.v1', context, { session_id: session.id }),
          work: context,
        });
      };

      const first = await attempt();
      const second = await attempt();

      expect(first.ok).toBe(true);
      expect(second).toMatchObject({
        ok: false,
        error: { kind: 'conflict', type: 'identity.stale_write' },
      });
    });

    /** Log in `identityId` with a session created `ageMs` ago; returns it as stored and its token. */
    async function login(identityId: ID, ageMs: number, evict: readonly Session[] = []) {
      const a = adapters();
      const createdAt = new Date(Date.now() - ageMs);
      const token = new SecretString(`token-${newId()}`);
      const session = value(
        Session.create({
          id: newId(),
          identityId,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 24 * 3600 * SECOND),
        }),
      );
      const context = work('identity.login');
      const evicted: SessionEviction[] = evict.map((stale) => ({
        session: value(stale.revoke(new Date())),
        event: event('identity.session_revoked.v1', context, { session_id: stale.id }),
      }));
      const committed = await a.sessionWriter.commit({
        session,
        tokenDigest: digestToken(token),
        event: event('identity.session_started.v1', context, { session_id: session.id }),
        evicted,
        work: context,
      });
      return { committed, token, session };
    }

    it('lists an identity\'s unrevoked sessions newest first', async () => {
      const { identity } = await register();
      const older = await login(identity.id, 30 * SECOND);
      const newer = await login(identity.id, 10 * SECOND);

      const listed = value(await adapters().active.listActive(identity.id));

      expect(listed.map((session) => session.id)).toEqual([newer.session.id, older.session.id]);
      expect(listed.every((session) => session.status === 'active' && session.version >= 1)).toBe(true);
    });

    it('revokes evicted sessions in the same write as the new login', async () => {
      const a = adapters();
      const { identity } = await register();
      const first = await login(identity.id, 30 * SECOND);
      const loaded = value(await a.active.listActive(identity.id))[0]!;

      const second = await login(identity.id, 0, [loaded]);

      expect(second.committed.ok).toBe(true);
      expect(value(await a.sessions.findByToken(first.token))?.status).toBe('revoked');
      expect(value(await a.active.listActive(identity.id)).map((session) => session.id)).toEqual([
        second.session.id,
      ]);
    });

    it('fails the login, storing nothing, when an evicted session changed meanwhile', async () => {
      const a = adapters();
      const { identity } = await register();
      await login(identity.id, 30 * SECOND);
      const loaded = value(await a.active.listActive(identity.id))[0]!;
      const context = work('identity.logout');
      value(
        await a.revocation.commit({
          session: value(loaded.revoke(new Date())),
          event: event('identity.session_revoked.v1', context, { session_id: loaded.id }),
          work: context,
        }),
      );

      const late = await login(identity.id, 0, [loaded]);

      expect(late.committed).toMatchObject({ ok: false, error: { type: 'identity.stale_write' } });
      expect(value(await a.sessions.findByToken(late.token))).toBeNull();
    });

    it('records use forward only, without changing the version', async () => {
      const a = adapters();
      const { identity } = await register();
      const { token, session } = await login(identity.id, 60 * SECOND);
      const used = new Date(session.createdAt.getTime() + 30 * SECOND);

      value(await a.activity.record(session.id, used));
      value(await a.activity.record(session.id, session.createdAt));

      const stored = value(await a.sessions.findByToken(token))!;
      expect(stored.lastSeenAt).toEqual(used);
      expect(stored.version).toBe(1);
    });

    it('prunes only sessions that ended before the cutoff', async () => {
      const a = adapters();
      const { identity } = await register();
      const live = await login(identity.id, 10 * SECOND);
      const idle = await login(identity.id, 3600 * SECOND);
      const revoked = await login(identity.id, 20 * SECOND);
      const loaded = value(await a.sessions.findByToken(revoked.token))!;
      const context = work('identity.logout');
      value(
        await a.revocation.commit({
          session: value(loaded.revoke(new Date(Date.now() - 5 * SECOND))),
          event: event('identity.session_revoked.v1', context, { session_id: loaded.id }),
          work: context,
        }),
      );

      const pruned = value(
        await a.pruner.prune({
          endedBefore: new Date(),
          idleBefore: new Date(Date.now() - 1800 * SECOND),
          limit: 100_000,
        }),
      );

      expect(pruned).toBeGreaterThanOrEqual(2);
      expect(value(await a.sessions.findByToken(live.token))).not.toBeNull();
      expect(value(await a.sessions.findByToken(idle.token))).toBeNull();
      expect(value(await a.sessions.findByToken(revoked.token))).toBeNull();
    });
  });
}

describe('in-memory Identity writers', () => {
  it('undo the write when publishing its event fails, like a rolled-back transaction', async () => {
    const store = new InMemoryIdentityStore({
      publish: async () => ({
        ok: false,
        error: { kind: 'unavailable', message: 'bus is down' } as never,
      }),
    });
    const createdAt = new Date();
    const identity = value(Identity.register({ id: newId(), createdAt }));
    const credential = value(
      Credential.createEmailPassword({
        id: newId(),
        identityId: identity.id,
        email: `rollback-${newId()}@example.com`,
        createdAt,
      }),
    );
    const context = work('identity.register');

    const result = await new InMemoryRegistrationWriter(store).commit({
      identity,
      credential,
      passwordHash: new SecretString('not-a-real-hash'),
      event: event('identity.registered.v1', context, { identity_id: identity.id }),
      work: context,
    });

    expect(result.ok).toBe(false);
    expect(store.identities.size).toBe(0);
    expect(store.credentials.size).toBe(0);
    expect(store.passwordHashes.size).toBe(0);
    expect(store.events).toHaveLength(0);
  });
});

let memory: Adapters | undefined;
contract('in-memory', () => {
  if (!memory) {
    const store = new InMemoryIdentityStore();
    memory = {
      registration: new InMemoryRegistrationWriter(store),
      identities: new InMemoryIdentityReader(store),
      challengeWriter: new InMemoryVerificationChallengeWriter(store),
      challenges: new InMemoryVerificationChallengeReader(store),
      verification: new InMemoryVerificationWriter(store),
      sessionWriter: new InMemorySessionWriter(store),
      sessions: new InMemoryCurrentSessionReader(store),
      revocation: new InMemorySessionRevocationWriter(store),
      activity: new InMemorySessionActivityWriter(store),
      active: new InMemoryActiveSessionReader(store),
      pruner: new InMemorySessionPruner(store),
    };
  }
  return memory;
});

postgresContract(
  (database): Adapters => ({
    registration: new PostgresRegistrationWriter(database),
    identities: new PostgresIdentityReader(database),
    challengeWriter: new PostgresVerificationChallengeWriter(database),
    challenges: new PostgresVerificationChallengeReader(database),
    verification: new PostgresVerificationWriter(database),
    sessionWriter: new PostgresSessionWriter(database),
    sessions: new PostgresCurrentSessionReader(database),
    revocation: new PostgresSessionRevocationWriter(database),
    activity: new PostgresSessionActivityWriter(database),
    active: new PostgresActiveSessionReader(database),
    pruner: new PostgresSessionPruner(database),
  }),
  (adapters) => contract('PostgreSQL', adapters),
);
