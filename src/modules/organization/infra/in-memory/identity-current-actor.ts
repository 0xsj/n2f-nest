import { Injectable } from '@nestjs/common';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import {
  GetCurrentIdentity,
  type IdentityView,
} from '../../../identity/app/index.js';
import type {
  CurrentActor,
  CurrentActorReader,
} from '../../app/index.js';

function actor(view: IdentityView): CurrentActor {
  return { identityId: view.identityId };
}

/** Composition adapter: Organization consumes an actor capability, not Identity internals. */
@Injectable()
export class IdentityCurrentActorReader implements CurrentActorReader {
  constructor(private readonly currentIdentity: GetCurrentIdentity) {}

  async findCurrent(
    sessionToken: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<CurrentActor, Failure>> {
    const result = await this.currentIdentity.execute({ sessionToken, signal });
    return result.ok ? { ok: true, value: actor(result.value) } : result;
  }
}
