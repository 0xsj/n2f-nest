import {
  err,
  ok,
  typedFailure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { IDENTITY_EVENT_TYPES } from '../../domain/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import {
  Credential,
  Identity,
  type IdentityStatus,
} from '../../domain/index.js';
import type {
  PasswordHasher,
  PasswordPolicy,
  RegistrationWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type IdentityApplicationFailure,
} from '../failures.js';

export type RegisterIdentityCommand = Readonly<{
  email: unknown;
  password: SecretString;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type RegisterIdentityResult = Readonly<{
  identityId: Identity['id'];
  credentialId: Credential['id'];
  status: IdentityStatus;
}>;

export type RegisterIdentityDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  passwordPolicy: PasswordPolicy;
  passwordHasher: PasswordHasher;
  writer: RegistrationWriter;
}>;

function invalidPassword(): IdentityApplicationFailure {
  return typedFailure(
    'invalid',
    'identity.empty_password',
    'password cannot be empty',
  );
}

export class RegisterIdentity {
  constructor(private readonly dependencies: RegisterIdentityDependencies) {}

  async execute(
    command: RegisterIdentityCommand,
  ): Promise<Result<RegisterIdentityResult, IdentityApplicationFailure>> {
    if (command.password.reveal().length === 0) {
      return err(invalidPassword());
    }

    const policy = this.dependencies.passwordPolicy.validate(command.password);

    if (!policy.ok) {
      return err(dependencyFailure(policy.error, 'password_policy'));
    }

    const createdAt = this.dependencies.clock.now();
    const identityId = this.dependencies.ids.newId();

    if (!identityId.ok) {
      return err(idGenerationFailure(identityId.error));
    }

    const identity = Identity.register({
      id: identityId.value,
      createdAt,
    });

    if (!identity.ok) {
      return identity;
    }

    const credentialId = this.dependencies.ids.newId();

    if (!credentialId.ok) {
      return err(idGenerationFailure(credentialId.error));
    }

    const credential = Credential.createEmailPassword({
      id: credentialId.value,
      identityId: identity.value.id,
      email: command.email,
      createdAt,
    });

    if (!credential.ok) {
      return credential;
    }

    const passwordHash = await this.dependencies.passwordHasher.hash(
      command.password,
      command.signal,
    );

    if (!passwordHash.ok) {
      return err(dependencyFailure(passwordHash.error, 'password_hasher'));
    }

    const eventId = this.dependencies.ids.newId();

    if (!eventId.ok) {
      return err(idGenerationFailure(eventId.error));
    }

    const event = Envelope.create(
      eventId.value,
      IDENTITY_EVENT_TYPES.registered,
      createdAt.getTime(),
      command.work,
      {
        identity_id: identity.value.id,
        credential_id: credential.value.id,
        credential_method: credential.value.method,
        status: identity.value.status,
      },
      { kind: 'identity', id: identity.value.id },
    );

    if (!event.ok) {
      return err(dependencyFailure(event.error, 'registration_event'));
    }

    const committed = await this.dependencies.writer.commit(
      {
        identity: identity.value,
        credential: credential.value,
        passwordHash: passwordHash.value,
        event: event.value,
        work: command.work,
      },
      command.signal,
    );

    if (!committed.ok) {
      return err(dependencyFailure(committed.error, 'registration_writer'));
    }

    return ok({
      identityId: identity.value.id,
      credentialId: credential.value.id,
      status: identity.value.status,
    });
  }
}
