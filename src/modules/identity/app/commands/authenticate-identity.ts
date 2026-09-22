import {
  err,
  ok,
  typedFailure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { PASSWORD_MAX_LENGTH } from '../ports/password-policy.js';
import { IDENTITY_EVENT_TYPES } from '../../domain/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { normalizeEmail, Session } from '../../domain/index.js';
import type {
  CredentialAuthenticatorReader,
  PasswordVerifier,
  SessionPolicy,
  SessionTokenIssuer,
  SessionWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type IdentityApplicationFailure,
} from '../failures.js';

export type AuthenticateIdentityCommand = Readonly<{
  email: unknown;
  password: SecretString;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type AuthenticateIdentityResult = Readonly<{
  identityId: ID;
  sessionId: ID;
  token: SecretString;
  expiresAt: Date;
}>;

export type AuthenticateIdentityDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  credentials: CredentialAuthenticatorReader;
  passwords: PasswordVerifier;
  sessions: SessionPolicy;
  tokens: SessionTokenIssuer;
  writer: SessionWriter;
}>;

function invalidCredentials(): IdentityApplicationFailure {
  return typedFailure(
    'unauthenticated',
    'identity.invalid_credentials',
    'credentials are invalid',
  );
}

export class AuthenticateIdentity {
  constructor(
    private readonly dependencies: AuthenticateIdentityDependencies,
  ) {}

  async execute(
    command: AuthenticateIdentityCommand,
  ): Promise<Result<AuthenticateIdentityResult, IdentityApplicationFailure>> {
    // Do not spend password-verifier work on an input outside Identity's
    // credential contract. Login still returns the same public refusal as any
    // other invalid credential so callers cannot distinguish this guard.
    if (command.password.reveal().length > PASSWORD_MAX_LENGTH) {
      return err(invalidCredentials());
    }

    const email = normalizeEmail(command.email);

    if (!email.ok) {
      return err(invalidCredentials());
    }

    const record = await this.dependencies.credentials.findByEmail(
      email.value,
      command.signal,
    );

    if (!record.ok) {
      return err(dependencyFailure(record.error, 'credential_reader'));
    }

    if (
      record.value === null ||
      record.value.identity.status !== 'active' ||
      record.value.credential.status !== 'active'
    ) {
      return err(invalidCredentials());
    }

    const password = await this.dependencies.passwords.verify(
      command.password,
      record.value.passwordHash,
      command.signal,
    );

    if (!password.ok) {
      return err(dependencyFailure(password.error, 'password_verifier'));
    }

    if (!password.value) {
      return err(invalidCredentials());
    }

    const createdAt = this.dependencies.clock.now();
    const expiresAt = this.dependencies.sessions.expiresAt(createdAt);

    if (!expiresAt.ok) {
      return err(dependencyFailure(expiresAt.error, 'session_policy'));
    }

    const sessionId = this.dependencies.ids.newId();

    if (!sessionId.ok) {
      return err(idGenerationFailure(sessionId.error));
    }

    const session = Session.create({
      id: sessionId.value,
      identityId: record.value.identity.id,
      createdAt,
      expiresAt: expiresAt.value,
    });

    if (!session.ok) {
      return session;
    }

    const token = await this.dependencies.tokens.issue(command.signal);

    if (!token.ok) {
      return err(dependencyFailure(token.error, 'session_token_issuer'));
    }

    const eventId = this.dependencies.ids.newId();

    if (!eventId.ok) {
      return err(idGenerationFailure(eventId.error));
    }

    const event = Envelope.create(
      eventId.value,
      IDENTITY_EVENT_TYPES.sessionCreated,
      createdAt.getTime(),
      command.work,
      {
        identity_id: record.value.identity.id,
        credential_id: record.value.credential.id,
        session_id: session.value.id,
        expires_at_ms: session.value.expiresAt.getTime(),
      },
    );

    if (!event.ok) {
      return err(dependencyFailure(event.error, 'session_created_event'));
    }

    const committed = await this.dependencies.writer.commit(
      {
        session: session.value,
        tokenDigest: token.value.digest,
        event: event.value,
        work: command.work,
      },
      command.signal,
    );

    if (!committed.ok) {
      return err(dependencyFailure(committed.error, 'session_writer'));
    }

    return ok({
      identityId: record.value.identity.id,
      sessionId: session.value.id,
      token: token.value.token,
      expiresAt: session.value.expiresAt,
    });
  }
}
