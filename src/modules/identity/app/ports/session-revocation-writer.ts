import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Session } from '../../domain/index.js';

export interface SessionRevocationWriter {
  commit(
    input: Readonly<{
      session: Session;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>>;
}
