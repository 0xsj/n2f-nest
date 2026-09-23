import { Injectable, Module } from '@nestjs/common';
import type { Failure, Result } from '../shared/errors/index.js';
import type { ID } from '../shared/id/index.js';
import type { SecretString } from '../shared/secret/index.js';
import {
  GetCurrentIdentity,
  GetIdentity,
  IdentityModule,
} from '../modules/identity/api.js';
import {
  ORGANIZATION_REQUIRES,
  type CurrentActor,
  type CurrentActorReader,
  type IdentityReference,
  type IdentityReferenceReader,
} from '../modules/organization/api.js';

/** Organization's acting identity, answered by Identity's current-session query. */
@Injectable()
export class IdentityCurrentActorBridge implements CurrentActorReader {
  constructor(private readonly currentIdentity: GetCurrentIdentity) {}

  async findCurrent(
    sessionToken: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<CurrentActor, Failure>> {
    const result = await this.currentIdentity.execute({ sessionToken, signal });
    return result.ok
      ? { ok: true, value: { identityId: result.value.identityId } }
      : result;
  }
}

/** Organization's "is this identity active?" check, answered by Identity's lookup query. */
@Injectable()
export class IdentityReferenceBridge implements IdentityReferenceReader {
  constructor(private readonly identities: GetIdentity) {}

  async findActive(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<IdentityReference | null, Failure>> {
    const result = await this.identities.execute({ identityId, signal });
    if (!result.ok) return result;
    return result.value?.status === 'active'
      ? { ok: true, value: { identityId: result.value.identityId } }
      : { ok: true, value: null };
  }
}

/** Supplies every ORGANIZATION_REQUIRES token from Identity. */
@Module({
  imports: [IdentityModule],
  providers: [
    IdentityCurrentActorBridge,
    IdentityReferenceBridge,
    { provide: ORGANIZATION_REQUIRES.currentActor, useExisting: IdentityCurrentActorBridge },
    {
      provide: ORGANIZATION_REQUIRES.identityReferences,
      useExisting: IdentityReferenceBridge,
    },
  ],
  exports: [ORGANIZATION_REQUIRES.currentActor, ORGANIZATION_REQUIRES.identityReferences],
})
export class OrganizationIdentityBridge {}
