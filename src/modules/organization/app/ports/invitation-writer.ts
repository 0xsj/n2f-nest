import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Invitation } from '../../domain/index.js';

export type InvitationCommit = Readonly<{
  invitation: Invitation;
  event: Envelope;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export interface InvitationWriter {
  commit(input: InvitationCommit): Promise<Result<void, Failure>>;
}

export type InvitationAcceptanceCommit = Readonly<{
  invitation: Invitation;
  membership: import('../../domain/index.js').Membership;
  events: readonly Envelope[];
  work: WorkContext;
  signal?: AbortSignal;
}>;

export interface InvitationAcceptanceWriter {
  commit(input: InvitationAcceptanceCommit): Promise<Result<void, Failure>>;
}
