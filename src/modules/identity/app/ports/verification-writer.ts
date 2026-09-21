import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Identity, VerificationChallenge } from '../../domain/index.js';

export interface VerificationWriter {
  commit(
    input: Readonly<{
      identity: Identity;
      challenge: VerificationChallenge;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>>;
}
