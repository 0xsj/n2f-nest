import { Injectable } from '@nestjs/common';
import { GetIdentity, type IdentityView } from '../../../identity/app/index.js';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type {
  IdentityReference,
  IdentityReferenceReader,
} from '../../app/index.js';

function reference(view: IdentityView): IdentityReference {
  return { identityId: view.identityId };
}

@Injectable()
export class IdentityReferenceReaderAdapter implements IdentityReferenceReader {
  constructor(private readonly identities: GetIdentity) {}

  async findActive(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<IdentityReference | null, Failure>> {
    const result = await this.identities.execute({ identityId, signal });
    if (!result.ok) return result;
    return result.value?.status === 'active'
      ? { ok: true, value: reference(result.value) }
      : { ok: true, value: null };
  }
}
