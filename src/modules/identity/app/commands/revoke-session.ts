import { err, ok, type Result } from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { IDENTITY_EVENT_TYPES } from '../../domain/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Session } from '../../domain/index.js';
import type {
  CurrentSessionReader,
  SessionRevocationWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type IdentityApplicationFailure,
} from '../failures.js';

export type RevokeSessionCommand = Readonly<{
  sessionToken: SecretString;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type RevokeSessionResult = Readonly<{
  sessionId: Session['id'] | null;
  revoked: boolean;
}>;

export type RevokeSessionDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  sessions: CurrentSessionReader;
  writer: SessionRevocationWriter;
}>;

export class RevokeSession {
  constructor(private readonly dependencies: RevokeSessionDependencies) {}

  async execute(
    command: RevokeSessionCommand,
  ): Promise<Result<RevokeSessionResult, IdentityApplicationFailure>> {
    const session = await this.dependencies.sessions.findByToken(
      command.sessionToken,
      command.signal,
    );

    if (!session.ok) {
      return err(dependencyFailure(session.error, 'current_session_reader'));
    }

    if (session.value === null || session.value.status === 'revoked') {
      return ok({
        sessionId: session.value?.id ?? null,
        revoked: false,
      });
    }

    const revoked = session.value.revoke(this.dependencies.clock.now());

    if (!revoked.ok) {
      return revoked;
    }

    const eventId = this.dependencies.ids.newId();

    if (!eventId.ok) {
      return err(idGenerationFailure(eventId.error));
    }

    const event = Envelope.create(
      eventId.value,
      IDENTITY_EVENT_TYPES.sessionRevoked,
      revoked.value.revokedAt!.getTime(),
      command.work,
      {
        identity_id: revoked.value.identityId,
        session_id: revoked.value.id,
        status: revoked.value.status,
      },
    );

    if (!event.ok) {
      return err(dependencyFailure(event.error, 'session_revoked_event'));
    }

    const committed = await this.dependencies.writer.commit(
      {
        session: revoked.value,
        event: event.value,
        work: command.work,
      },
      command.signal,
    );

    if (!committed.ok) {
      return err(
        dependencyFailure(committed.error, 'session_revocation_writer'),
      );
    }

    return ok({
      sessionId: revoked.value.id,
      revoked: true,
    });
  }
}
