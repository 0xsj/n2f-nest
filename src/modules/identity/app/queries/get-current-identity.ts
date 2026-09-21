import { match } from 'ts-pattern';
import {
  err,
  typedFailure,
  type Failure,
  type TypedFailure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  CurrentSessionReader,
  IdentityView,
  IdentityViewReader,
} from '../ports/index.js';
import type { SessionFailure } from '../../domain/index.js';

export type CurrentIdentityFailure =
  | TypedFailure<
      'unauthenticated',
      'identity.current_unavailable' | 'session.revoked' | 'session.expired'
    >
  | TypedFailure<'internal', 'identity.invalid_session_state'>
  | TypedFailure<
      'unavailable',
      | 'identity.session_reader_unavailable'
      | 'identity.identity_reader_unavailable'
    >;

export type GetCurrentIdentityQuery = Readonly<{
  sessionToken: SecretString;
  signal?: AbortSignal;
}>;

export type GetCurrentIdentityDependencies = Readonly<{
  clock: WallClock;
  sessions: CurrentSessionReader;
  identities: IdentityViewReader;
}>;

function unauthenticated(): TypedFailure<
  'unauthenticated',
  'identity.current_unavailable'
> {
  return typedFailure(
    'unauthenticated',
    'identity.current_unavailable',
    'current Identity is unavailable',
  );
}

function sessionReaderUnavailable(
  error: Failure,
): TypedFailure<'unavailable', 'identity.session_reader_unavailable'> {
  return typedFailure(
    'unavailable',
    'identity.session_reader_unavailable',
    'current Identity session storage is unavailable',
    { cause: error },
  );
}

function identityReaderUnavailable(
  error: Failure,
): TypedFailure<'unavailable', 'identity.identity_reader_unavailable'> {
  return typedFailure(
    'unavailable',
    'identity.identity_reader_unavailable',
    'current Identity storage is unavailable',
    { cause: error },
  );
}

function invalidSessionState(
  error: SessionFailure,
): TypedFailure<'internal', 'identity.invalid_session_state'> {
  return typedFailure(
    'internal',
    'identity.invalid_session_state',
    'current Identity session state is invalid',
    { cause: error },
  );
}

function sessionFailure(error: SessionFailure): CurrentIdentityFailure {
  return match(error)
    .with({ type: 'session.revoked' }, (revoked) => revoked)
    .with({ type: 'session.expired' }, (expired) => expired)
    .with({ kind: 'invalid' }, (invalid) => invalidSessionState(invalid))
    .exhaustive();
}

function copyView(view: IdentityView): IdentityView {
  return {
    identityId: view.identityId,
    status: view.status,
    verifiedAt:
      view.verifiedAt === null ? null : new Date(view.verifiedAt.getTime()),
  };
}

export class GetCurrentIdentity {
  constructor(private readonly dependencies: GetCurrentIdentityDependencies) {}

  async execute(
    query: GetCurrentIdentityQuery,
  ): Promise<Result<IdentityView, CurrentIdentityFailure>> {
    const session = await this.dependencies.sessions.findByToken(
      query.sessionToken,
      query.signal,
    );

    if (!session.ok) {
      return err(sessionReaderUnavailable(session.error));
    }

    if (session.value === null) {
      return err(unauthenticated());
    }

    const usable = session.value.assertUsable(this.dependencies.clock.now());

    if (!usable.ok) {
      return err(sessionFailure(usable.error));
    }

    const identity = await this.dependencies.identities.findById(
      session.value.identityId,
      query.signal,
    );

    if (!identity.ok) {
      return err(identityReaderUnavailable(identity.error));
    }

    if (identity.value === null || identity.value.status !== 'active') {
      return err(unauthenticated());
    }

    return {
      ok: true,
      value: copyView(identity.value),
    };
  }
}
