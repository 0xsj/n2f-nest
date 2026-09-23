import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork, type Envelope } from '../../../../shared/events/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  CredentialAuthenticationRecord,
  CredentialAuthenticatorReader,
  CurrentSessionReader,
  IdentityReader,
  IdentityView,
  IdentityViewReader,
  ActiveSessionReader,
  PasswordResetWriter,
  RegistrationWriter,
  SessionActivityWriter,
  SessionEviction,
  SessionPruner,
  SessionRevocationWriter,
  SessionWriter,
  VerificationChallengeReader,
  VerificationChallengeRecord,
  VerificationChallengeWriter,
  VerificationWriter,
} from '../../app/ports/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type {
  Credential,
  Identity,
  Session,
  VerificationChallenge,
} from '../../domain/index.js';
import {
  alreadyExists,
  challengeExists,
  emailTaken,
  sessionExists,
  staleWrite,
} from '../failures.js';
import { digestToken } from './crypto.js';
import { InMemoryIdentityStore } from './store.js';

const sessionNotFound = (): Failure =>
  failure('not_found', 'session was not found', { type: 'identity.session_not_found' });

function unavailable(message: string, type: string): Failure {
  return failure('unavailable', message, { type });
}

/**
 * Apply a write, then publish its event; undo the write if publishing fails.
 * This mirrors the PostgreSQL adapters, where state and outbox commit together
 * or not at all.
 */
async function commit(
  store: InMemoryIdentityStore,
  event: Envelope,
  work: WorkContext,
  apply: () => () => void,
): Promise<Result<void, Failure>> {
  return commitAll(store, [event], work, apply);
}

/**
 * `commit` for a write with several events. Events already handed on when a
 * later one fails cannot be withdrawn; the in-memory bus only records them,
 * so this does not arise in practice.
 */
async function commitAll(
  store: InMemoryIdentityStore,
  events: readonly Envelope[],
  work: WorkContext,
  apply: () => () => void,
): Promise<Result<void, Failure>> {
  for (const event of events) {
    const valid = assertEventWork(event, work);
    if (!valid.ok) return valid;
  }
  const undo = apply();
  for (const event of events) {
    store.events.push(event);
    const dispatched = await store.dispatch(event);
    if (!dispatched.ok) {
      store.events.splice(store.events.lastIndexOf(event), 1);
      undo();
      return dispatched;
    }
  }
  return ok(undefined);
}

/** Restore a map entry to what it held before a write. */
function restorer<K, V>(map: Map<K, V>, key: K): () => void {
  const had = map.has(key);
  const previous = map.get(key);
  return () => {
    if (had) map.set(key, previous as V);
    else map.delete(key);
  };
}

export class InMemoryRegistrationWriter implements RegistrationWriter {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async commit(input: {
    identity: Identity;
    credential: Credential;
    passwordHash: SecretString;
    event: Envelope;
    work: WorkContext;
  }): Promise<Result<void, Failure>> {
    if (this.store.identities.has(input.identity.id)) {
      return err(alreadyExists());
    }
    if (
      [...this.store.credentials.values()].some(
        (credential) => credential.email === input.credential.email,
      )
    ) {
      return err(emailTaken());
    }

    const { identities, credentials, passwordHashes } = this.store;
    return commit(this.store, input.event, input.work, () => {
      const undo = [
        restorer(identities, input.identity.id),
        restorer(credentials, input.credential.id),
        restorer(passwordHashes, input.credential.id),
      ];
      identities.set(input.identity.id, input.identity.saved());
      credentials.set(input.credential.id, input.credential);
      passwordHashes.set(input.credential.id, input.passwordHash);
      return () => undo.forEach((step) => step());
    });
  }
}

export class InMemoryIdentityReader implements IdentityReader {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async find(identityId: ID): Promise<Result<Identity | null, Failure>> {
    return ok(this.store.identities.get(identityId) ?? null);
  }
}

export class InMemoryCredentialAuthenticatorReader
  implements CredentialAuthenticatorReader
{
  constructor(private readonly store: InMemoryIdentityStore) {}

  async findByEmail(
    email: CredentialAuthenticationRecord['credential']['email'],
  ): Promise<Result<CredentialAuthenticationRecord | null, Failure>> {
    const credential = [...this.store.credentials.values()].find(
      (candidate) => candidate.email === email,
    );
    if (!credential) return ok(null);

    const identity = this.store.identities.get(credential.identityId);
    const passwordHash = this.store.passwordHashes.get(credential.id);
    if (!identity || !passwordHash) {
      return err(
        unavailable(
          'identity credential state is incomplete',
          'identity.incomplete_state',
        ),
      );
    }

    return ok({ identity, credential, passwordHash });
  }

  async findByIdentity(identityId: ID): Promise<Result<CredentialAuthenticationRecord | null, Failure>> {
    const credential = [...this.store.credentials.values()].find(
      (candidate) => candidate.identityId === identityId && candidate.status === 'active',
    );
    return credential ? this.findByEmail(credential.email) : ok(null);
  }
}

export class InMemoryIdentityViewReader implements IdentityViewReader {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async findById(identityId: ID): Promise<Result<IdentityView | null, Failure>> {
    const identity = this.store.identities.get(identityId);
    if (!identity) return ok(null);
    return ok({
      identityId: identity.id,
      status: identity.status,
      verifiedAt: identity.verifiedAt,
    });
  }
}

export class InMemoryVerificationChallengeWriter
  implements VerificationChallengeWriter
{
  constructor(private readonly store: InMemoryIdentityStore) {}

  async commit(input: {
    challenge: VerificationChallenge;
    tokenDigest: SecretString;
    event: Envelope;
    work: WorkContext;
  }): Promise<Result<void, Failure>> {
    if (this.store.challenges.has(input.challenge.id)) {
      return err(challengeExists());
    }
    const { challenges } = this.store;
    return commit(this.store, input.event, input.work, () => {
      const undo = restorer(challenges, input.challenge.id);
      challenges.set(input.challenge.id, {
        challenge: input.challenge.saved(),
        tokenDigest: input.tokenDigest,
      });
      return undo;
    });
  }
}

export class InMemoryVerificationChallengeReader
  implements VerificationChallengeReader
{
  constructor(private readonly store: InMemoryIdentityStore) {}

  async find(
    challengeId: ID,
  ): Promise<Result<VerificationChallengeRecord | null, Failure>> {
    return ok(this.store.challenges.get(challengeId) ?? null);
  }
}

export class InMemoryVerificationWriter implements VerificationWriter {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async commit(input: {
    identity: Identity;
    challenge: VerificationChallenge;
    event: Envelope;
    work: WorkContext;
  }): Promise<Result<void, Failure>> {
    const identity = this.store.identities.get(input.identity.id);
    if (!identity) {
      return err(failure('not_found', 'identity was not found', {
        type: 'identity.not_found',
      }));
    }
    const stored = this.store.challenges.get(input.challenge.id);
    if (!stored || stored.challenge.identityId !== input.identity.id) {
      return err(failure('not_found', 'verification challenge was not found', {
        type: 'identity.verification_not_found',
      }));
    }
    if (
      identity.version !== input.identity.version ||
      stored.challenge.version !== input.challenge.version
    ) {
      return err(staleWrite());
    }

    const { identities, challenges } = this.store;
    return commit(this.store, input.event, input.work, () => {
      const undo = [
        restorer(identities, input.identity.id),
        restorer(challenges, input.challenge.id),
      ];
      identities.set(input.identity.id, input.identity.saved());
      challenges.set(input.challenge.id, {
        challenge: input.challenge.saved(),
        tokenDigest: stored.tokenDigest,
      });
      return () => undo.forEach((step) => step());
    });
  }
}

export class InMemorySessionWriter implements SessionWriter {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async commit(input: {
    session: Session;
    credential: Credential;
    tokenDigest: SecretString;
    event: Envelope;
    evicted: readonly SessionEviction[];
    work: WorkContext;
  }): Promise<Result<void, Failure>> {
    if (this.store.sessions.has(input.session.id)) {
      return err(sessionExists());
    }
    const current = this.store.credentials.get(input.credential.id);
    if (
      !current ||
      current.status !== 'active' ||
      current.updatedAt.getTime() !== input.credential.updatedAt.getTime()
    ) {
      return err(staleWrite());
    }
    const { sessions } = this.store;
    for (const { session } of input.evicted) {
      const stored = sessions.get(session.id);
      if (!stored) return err(sessionNotFound());
      if (stored.session.version !== session.version) return err(staleWrite());
    }
    const events = [...input.evicted.map((eviction) => eviction.event), input.event];
    return commitAll(this.store, events, input.work, () => {
      const undo = [
        restorer(sessions, input.session.id),
        ...input.evicted.map(({ session }) => restorer(sessions, session.id)),
      ];
      for (const { session } of input.evicted) {
        const stored = sessions.get(session.id)!;
        sessions.set(session.id, { session: session.saved(), tokenDigest: stored.tokenDigest });
      }
      sessions.set(input.session.id, {
        session: input.session.saved(),
        tokenDigest: input.tokenDigest,
      });
      return () => undo.forEach((step) => step());
    });
  }
}

export class InMemoryCurrentSessionReader implements CurrentSessionReader {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async findByToken(token: SecretString): Promise<Result<Session | null, Failure>> {
    const digest = digestToken(token).reveal();
    const stored = [...this.store.sessions.values()].find(
      (candidate) => candidate.tokenDigest.reveal() === digest,
    );
    return ok(stored?.session ?? null);
  }
}

export class InMemorySessionRevocationWriter
  implements SessionRevocationWriter
{
  constructor(private readonly store: InMemoryIdentityStore) {}

  async commit(input: {
    session: Session;
    event: Envelope;
    work: WorkContext;
  }): Promise<Result<void, Failure>> {
    const stored = this.store.sessions.get(input.session.id);
    if (!stored) {
      return err(sessionNotFound());
    }
    if (stored.session.version !== input.session.version) {
      return err(staleWrite());
    }
    const { sessions } = this.store;
    return commit(this.store, input.event, input.work, () => {
      const undo = restorer(sessions, input.session.id);
      sessions.set(input.session.id, {
        session: input.session.saved(),
        tokenDigest: stored.tokenDigest,
      });
      return undo;
    });
  }
}

export class InMemorySessionActivityWriter implements SessionActivityWriter {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async record(sessionId: ID, at: Date): Promise<Result<void, Failure>> {
    const stored = this.store.sessions.get(sessionId);
    if (stored) {
      this.store.sessions.set(sessionId, { ...stored, session: stored.session.seen(at) });
    }
    return ok(undefined);
  }
}

export class InMemoryActiveSessionReader implements ActiveSessionReader {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async listActive(identityId: ID): Promise<Result<readonly Session[], Failure>> {
    return ok(
      [...this.store.sessions.values()]
        .map((stored) => stored.session)
        .filter((session) => session.identityId === identityId && session.status === 'active')
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        ),
    );
  }
}

export class InMemorySessionPruner implements SessionPruner {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async prune(
    input: Readonly<{ endedBefore: Date; idleBefore: Date; limit: number }>,
  ): Promise<Result<number, Failure>> {
    const ended = input.endedBefore.getTime();
    let pruned = 0;
    for (const [id, { session }] of this.store.sessions) {
      if (pruned >= input.limit) break;
      if (
        (session.revokedAt !== null && session.revokedAt.getTime() < ended) ||
        session.expiresAt.getTime() < ended ||
        session.lastSeenAt.getTime() < input.idleBefore.getTime()
      ) {
        this.store.sessions.delete(id);
        pruned += 1;
      }
    }
    return ok(pruned);
  }
}

export class InMemoryPasswordResetWriter implements PasswordResetWriter {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async commit(input: {
    challenge: VerificationChallenge;
    credential: Credential;
    previousUpdatedAt: Date;
    passwordHash: SecretString;
    identity: Identity | null;
    revoked: readonly SessionEviction[];
    events: readonly Envelope[];
    work: WorkContext;
  }): Promise<Result<void, Failure>> {
    const { credentials, passwordHashes, challenges, identities, sessions } = this.store;
    const credential = credentials.get(input.credential.id);
    if (
      !credential ||
      credential.status !== 'active' ||
      credential.updatedAt.getTime() !== input.previousUpdatedAt.getTime()
    ) {
      return err(staleWrite());
    }
    const challenge = challenges.get(input.challenge.id);
    if (!challenge || challenge.challenge.purpose !== 'password_reset') {
      return err(failure('not_found', 'verification challenge was not found', {
        type: 'identity.verification_not_found',
      }));
    }
    if (challenge.challenge.version !== input.challenge.version) return err(staleWrite());
    if (input.identity) {
      const identity = identities.get(input.identity.id);
      if (!identity) return err(failure('not_found', 'identity was not found', { type: 'identity.not_found' }));
      if (identity.version !== input.identity.version) return err(staleWrite());
    }
    for (const { session } of input.revoked) {
      if (sessions.get(session.id)?.session.version !== session.version) return err(staleWrite());
    }
    const listed = new Set(input.revoked.map(({ session }) => session.id));
    for (const { session } of sessions.values()) {
      if (session.identityId === input.credential.identityId && session.status === 'active' && !listed.has(session.id)) {
        return err(staleWrite());
      }
    }

    return commitAll(this.store, input.events, input.work, () => {
      const undo = [
        restorer(credentials, input.credential.id),
        restorer(passwordHashes, input.credential.id),
        restorer(challenges, input.challenge.id),
        ...(input.identity ? [restorer(identities, input.identity.id)] : []),
        ...input.revoked.map(({ session }) => restorer(sessions, session.id)),
      ];
      credentials.set(input.credential.id, input.credential);
      passwordHashes.set(input.credential.id, input.passwordHash);
      challenges.set(input.challenge.id, { challenge: input.challenge.saved(), tokenDigest: challenge.tokenDigest });
      if (input.identity) identities.set(input.identity.id, input.identity.saved());
      for (const { session } of input.revoked) {
        const stored = sessions.get(session.id)!;
        sessions.set(session.id, { session: session.saved(), tokenDigest: stored.tokenDigest });
      }
      return () => undo.forEach((step) => step());
    });
  }
}
