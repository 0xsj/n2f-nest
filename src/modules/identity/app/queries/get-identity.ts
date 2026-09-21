import {
  err,
  typedFailure,
  type Failure,
  type Result,
  type TypedFailure,
} from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { IdentityView, IdentityViewReader } from '../ports/index.js';

export type GetIdentityQuery = Readonly<{
  identityId: ID;
  signal?: AbortSignal;
}>;

export type GetIdentityDependencies = Readonly<{
  identities: IdentityViewReader;
}>;

export type GetIdentityFailure = TypedFailure<
  'unavailable',
  'identity.identity_reader_unavailable'
>;

function identityReaderUnavailable(error: Failure): GetIdentityFailure {
  return typedFailure(
    'unavailable',
    'identity.identity_reader_unavailable',
    'Identity storage is unavailable',
    { cause: error },
  );
}

function copyView(view: IdentityView): IdentityView {
  return {
    identityId: view.identityId,
    status: view.status,
    verifiedAt:
      view.verifiedAt === null ? null : new Date(view.verifiedAt.getTime()),
  };
}

export class GetIdentity {
  constructor(private readonly dependencies: GetIdentityDependencies) {}

  async execute(
    query: GetIdentityQuery,
  ): Promise<Result<IdentityView | null, GetIdentityFailure>> {
    const result = await this.dependencies.identities.findById(
      query.identityId,
      query.signal,
    );
    if (!result.ok) return err(identityReaderUnavailable(result.error));
    return result.value === null
      ? result
      : { ok: true, value: copyView(result.value) };
  }
}
