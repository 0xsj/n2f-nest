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
  RegistrationWriter,
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
import { digestToken } from './crypto.js';
import { InMemoryIdentityStore } from './store.js';

function conflict(message: string, type: string): Failure {
  return failure('conflict', message, { type });
}

function unavailable(message: string, type: string): Failure {
  return failure('unavailable', message, { type });
}

function append(
  store: InMemoryIdentityStore,
  event: Envelope,
  work: WorkContext,
): Result<void, Failure> {
  const valid = assertEventWork(event, work);
  if (!valid.ok) return valid;
  store.events.push(event);
  return ok(undefined);
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
      return err(conflict('identity already exists', 'identity.already_exists'));
    }
    if (
      [...this.store.credentials.values()].some(
        (credential) => credential.email === input.credential.email,
      )
    ) {
      return err(conflict('email is already registered', 'identity.email_taken'));
    }

    const appended = append(this.store, input.event, input.work);
    if (!appended.ok) return appended;
    this.store.identities.set(input.identity.id, input.identity);
    this.store.credentials.set(input.credential.id, input.credential);
    this.store.passwordHashes.set(input.credential.id, input.passwordHash);
    return this.store.dispatch(input.event);
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
      return err(
        conflict(
          'verification challenge already exists',
          'identity.challenge_already_exists',
        ),
      );
    }
    const appended = append(this.store, input.event, input.work);
    if (!appended.ok) return appended;
    this.store.challenges.set(input.challenge.id, {
      challenge: input.challenge,
      tokenDigest: input.tokenDigest,
    });
    return this.store.dispatch(input.event);
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
    if (!this.store.identities.has(input.identity.id)) {
      return err(failure('not_found', 'identity was not found', {
        type: 'identity.not_found',
      }));
    }
    if (!this.store.challenges.has(input.challenge.id)) {
      return err(failure('not_found', 'verification challenge was not found', {
        type: 'identity.verification_not_found',
      }));
    }
    const stored = this.store.challenges.get(input.challenge.id)!;
    const appended = append(this.store, input.event, input.work);
    if (!appended.ok) return appended;
    this.store.identities.set(input.identity.id, input.identity);
    this.store.challenges.set(input.challenge.id, {
      challenge: input.challenge,
      tokenDigest: stored.tokenDigest,
    });
    return this.store.dispatch(input.event);
  }
}

export class InMemorySessionWriter implements SessionWriter {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async commit(input: {
    session: Session;
    tokenDigest: SecretString;
    event: Envelope;
    work: WorkContext;
  }): Promise<Result<void, Failure>> {
    if (this.store.sessions.has(input.session.id)) {
      return err(conflict('session already exists', 'identity.session_already_exists'));
    }
    const appended = append(this.store, input.event, input.work);
    if (!appended.ok) return appended;
    this.store.sessions.set(input.session.id, {
      session: input.session,
      tokenDigest: input.tokenDigest,
    });
    return this.store.dispatch(input.event);
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
      return err(failure('not_found', 'session was not found', {
        type: 'identity.session_not_found',
      }));
    }
    const appended = append(this.store, input.event, input.work);
    if (!appended.ok) return appended;
    this.store.sessions.set(input.session.id, {
      session: input.session,
      tokenDigest: stored.tokenDigest,
    });
    return this.store.dispatch(input.event);
  }
}
