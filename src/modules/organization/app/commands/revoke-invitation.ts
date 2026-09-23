import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type {
  CurrentActorReader,
  InvitationReader,
  InvitationWriter,
  MembershipReader,
} from '../ports/index.js';
import { INVITATION_EVENT_TYPES } from '../../domain/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type OrganizationApplicationFailure,
} from '../failures.js';

export type RevokeInvitationCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  invitationId: ID;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type RevokeInvitationDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  actors: CurrentActorReader;
  invitations: InvitationReader;
  memberships: MembershipReader;
  writer: InvitationWriter;
}>;

export type RevokeInvitationResult = Readonly<{
  invitationId: ID;
  status: 'revoked';
}>;

function idFailure(error: Failure): OrganizationApplicationFailure {
  return idGenerationFailure(error, 'organization.invitation.id_generation');
}

export class RevokeInvitation {
  constructor(private readonly dependencies: RevokeInvitationDependencies) {}

  async execute(
    command: RevokeInvitationCommand,
  ): Promise<Result<RevokeInvitationResult, OrganizationApplicationFailure>> {
    if (
      command.work.snapshot().operation !== 'organization.invitation.revoke'
    ) {
      return err(
        failure('invalid', 'invitation revocation operation is invalid', {
          type: 'organization.invitation.invalid_operation',
        }),
      );
    }

    const actor = await this.dependencies.actors.findCurrent(
      command.sessionToken,
      command.signal,
    );
    if (!actor.ok) return err(dependencyFailure(actor.error, 'identity.current.find'));

    // Authorize before looking the target up, so a non-owner cannot tell
    // which IDs exist in another organization.
    const actorMembership =
      await this.dependencies.memberships.findActiveForIdentity(
        command.organizationId,
        actor.value.identityId,
        command.signal,
      );
    if (!actorMembership.ok) return err(dependencyFailure(actorMembership.error, 'membership.findActiveForIdentity'));
    if (
      actorMembership.value === null ||
      actorMembership.value.role !== 'owner'
    ) {
      return err(
        failure(
          'forbidden',
          'only an organization owner can revoke invitations',
          {
            type: 'organization.invitation.revoke_forbidden',
          },
        ),
      );
    }

    const invitation = await this.dependencies.invitations.findById(
      command.invitationId,
      command.signal,
    );
    if (!invitation.ok) return err(dependencyFailure(invitation.error, 'invitation.findById'));
    if (
      invitation.value === null ||
      invitation.value.organizationId !== command.organizationId
    ) {
      return err(
        failure('not_found', 'invitation was not found', {
          type: 'organization.invitation.not_found',
        }),
      );
    }

    const revokedAt = this.dependencies.clock.now();
    const revoked = invitation.value.revoke(revokedAt);
    if (!revoked.ok) return revoked;

    const eventId = this.dependencies.ids.newId();
    if (!eventId.ok) return err(idFailure(eventId.error));
    const event = Envelope.create(
      eventId.value,
      INVITATION_EVENT_TYPES.revoked,
      revokedAt.getTime(),
      command.work,
      {
        organization_id: revoked.value.organizationId,
        identity_id: revoked.value.identityId,
        invitation_id: revoked.value.id,
        role: revoked.value.role,
      },
      { kind: 'invitation', id: revoked.value.id },
      revoked.value.organizationId,
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      invitation: revoked.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'invitation.commit'));

    return ok({ invitationId: revoked.value.id, status: 'revoked' });
  }
}
