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
import {
  INVITATION_EVENT_TYPES,
  MEMBERSHIP_EVENT_TYPES,
  Membership,
} from '../../domain/index.js';
import type {
  CurrentActorReader,
  InvitationReader,
  InvitationAcceptanceWriter,
  MembershipReader,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type OrganizationApplicationFailure,
} from '../failures.js';

export type AcceptInvitationCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  invitationId: ID;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type AcceptInvitationDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  actors: CurrentActorReader;
  invitations: InvitationReader;
  memberships: MembershipReader;
  writer: InvitationAcceptanceWriter;
}>;

export type AcceptInvitationResult = Readonly<{
  invitationId: ID;
  membershipId: ID;
  organizationId: ID;
  identityId: ID;
  role: 'admin' | 'member';
}>;

function idFailure(error: Failure): OrganizationApplicationFailure {
  return idGenerationFailure(error, 'organization.invitation.id_generation');
}

function operationFailure(work: WorkContext): OrganizationApplicationFailure | undefined {
  return work.snapshot().operation === 'organization.invitation.accept'
    ? undefined
    : failure('invalid', 'invitation acceptance operation is invalid', {
        type: 'organization.invitation.invalid_operation',
      });
}

export class AcceptInvitation {
  constructor(private readonly dependencies: AcceptInvitationDependencies) {}

  async execute(
    command: AcceptInvitationCommand,
  ): Promise<Result<AcceptInvitationResult, OrganizationApplicationFailure>> {
    const operation = operationFailure(command.work);
    if (operation) return err(operation);

    const actor = await this.dependencies.actors.findCurrent(
      command.sessionToken,
      command.signal,
    );
    if (!actor.ok) return err(dependencyFailure(actor.error, 'identity.current.find'));

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
    if (invitation.value.identityId !== actor.value.identityId) {
      return err(
        failure(
          'forbidden',
          'only the invited identity can accept this invitation',
          {
            type: 'organization.invitation.accept_forbidden',
          },
        ),
      );
    }

    const existingMembership =
      await this.dependencies.memberships.findForIdentity(
        command.organizationId,
        actor.value.identityId,
        command.signal,
      );
    if (!existingMembership.ok) return err(dependencyFailure(existingMembership.error, 'membership.findForIdentity'));
    if (existingMembership.value !== null) {
      return err(
        failure('conflict', 'identity already has an organization membership', {
          type: 'organization.invitation.membership_exists',
        }),
      );
    }

    const acceptedAt = this.dependencies.clock.now();
    const accepted = invitation.value.accept(acceptedAt);
    if (!accepted.ok) return accepted;

    const membershipId = this.dependencies.ids.newId();
    if (!membershipId.ok) return err(idFailure(membershipId.error));
    const membership = Membership.add({
      id: membershipId.value,
      organizationId: accepted.value.organizationId,
      identityId: accepted.value.identityId,
      role: accepted.value.role,
      createdAt: acceptedAt,
    });
    if (!membership.ok) return membership;

    const invitationEventId = this.dependencies.ids.newId();
    if (!invitationEventId.ok) return err(idFailure(invitationEventId.error));
    const invitationEvent = Envelope.create(
      invitationEventId.value,
      INVITATION_EVENT_TYPES.accepted,
      acceptedAt.getTime(),
      command.work,
      {
        organization_id: accepted.value.organizationId,
        identity_id: accepted.value.identityId,
        invitation_id: accepted.value.id,
        role: accepted.value.role,
      },
    );
    if (!invitationEvent.ok) return err(dependencyFailure(invitationEvent.error, 'event.create'));

    const membershipEventId = this.dependencies.ids.newId();
    if (!membershipEventId.ok) return err(idFailure(membershipEventId.error));
    const membershipEvent = Envelope.create(
      membershipEventId.value,
      MEMBERSHIP_EVENT_TYPES.added,
      acceptedAt.getTime(),
      command.work,
      {
        organization_id: membership.value.organizationId,
        identity_id: membership.value.identityId,
        membership_id: membership.value.id,
        role: membership.value.role,
        invitation_id: accepted.value.id,
      },
    );
    if (!membershipEvent.ok) return err(dependencyFailure(membershipEvent.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      invitation: accepted.value,
      membership: membership.value,
      events: [invitationEvent.value, membershipEvent.value],
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'invitation.accept'));

    return ok({
      invitationId: accepted.value.id,
      membershipId: membership.value.id,
      organizationId: membership.value.organizationId,
      identityId: membership.value.identityId,
      role: accepted.value.role,
    });
  }
}
