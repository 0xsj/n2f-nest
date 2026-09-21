import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Membership } from '../../domain/index.js';

export type MembershipCommit = Readonly<{
  membership: Membership;
  event: Envelope;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export interface MembershipWriter {
  commit(input: MembershipCommit): Promise<Result<void, Failure>>;
}
