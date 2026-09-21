import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Session } from '../../domain/index.js';

export interface SessionWriter {
  commit(
    input: Readonly<{
      session: Session;
      tokenDigest: SecretString;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>>;
}
