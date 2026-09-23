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
  Invitation,
  type InvitationRole,
} from '../../domain/index.js';
import type {
  CurrentActorReader,
  IdentityReferenceReader,
  InvitationReader,
  InvitationWriter,
  MembershipReader,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type OrganizationApplicationFailure,
} from '../failures.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteIdentityCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  identityId: ID;
  role: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type InviteIdentityDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  actors: CurrentActorReader;
  identities: IdentityReferenceReader;
  memberships: MembershipReader;
  invitations: InvitationReader;
  writer: InvitationWriter;
}>;

export type InviteIdentityResult = Readonly<{
  invitationId: ID;
  identityId: ID;
  role: InvitationRole;
  status: 'pending';
  expiresAt: Date;
}>;

function idFailure(error: Failure): OrganizationApplicationFailure {
  return idGenerationFailure(error, 'organization.invitation.id_generation');
}

function operationFailure(work: WorkContext): OrganizationApplicationFailure | undefined {
  return work.snapshot().operation === 'organization.invitation.create'
    ? undefined
    : failure('invalid', 'invitation operation is invalid', {
        type: 'organization.invitation.invalid_operation',
      });
}

export class InviteIdentity {
  constructor(private readonly dependencies: InviteIdentityDependencies) {}

  async execute(
    command: InviteIdentityCommand,
  ): Promise<Result<InviteIdentityResult, OrganizationApplicationFailure>> {
    const operation = operationFailure(command.work);
    if (operation) return err(operation);

    const actor = await this.dependencies.actors.findCurrent(
      command.sessionToken,
      command.signal,
    );
    if (!actor.ok) return err(dependencyFailure(actor.error, 'identity.current.find'));

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
          'only an organization owner can create invitations',
          {
            type: 'organization.invitation.forbidden',
          },
        ),
      );
    }

    const identity = await this.dependencies.identities.findActive(
      command.identityId,
      command.signal,
    );
    if (!identity.ok) return err(dependencyFailure(identity.error, 'identity.findActive'));
    if (identity.value === null) {
      return err(
        failure('not_found', 'identity was not found', {
          type: 'organization.invitation.identity_not_found',
        }),
      );
    }

    const membership = await this.dependencies.memberships.findForIdentity(
      command.organizationId,
      command.identityId,
      command.signal,
    );
    if (!membership.ok) return err(dependencyFailure(membership.error, 'membership.findForIdentity'));
    if (membership.value !== null) {
      return err(
        failure('conflict', 'identity already has an organization membership', {
          type: 'organization.invitation.membership_exists',
        }),
      );
    }

    const existing = await this.dependencies.invitations.findPendingForIdentity(
      command.organizationId,
      command.identityId,
      command.signal,
    );
    if (!existing.ok) return err(dependencyFailure(existing.error, 'invitation.findPendingForIdentity'));
    if (existing.value !== null) {
      return err(
        failure('conflict', 'an invitation is already pending', {
          type: 'organization.invitation.already_exists',
        }),
      );
    }

    const createdAt = this.dependencies.clock.now();
    const id = this.dependencies.ids.newId();
    if (!id.ok) return err(idFailure(id.error));
    const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS);
    const invitation = Invitation.issue({
      id: id.value,
      organizationId: command.organizationId,
      identityId: command.identityId,
      role: command.role,
      createdAt,
      expiresAt,
    });
    if (!invitation.ok) return invitation;

    const eventId = this.dependencies.ids.newId();
    if (!eventId.ok) return err(idFailure(eventId.error));
    const event = Envelope.create(
      eventId.value,
      INVITATION_EVENT_TYPES.created,
      createdAt.getTime(),
      command.work,
      {
        organization_id: invitation.value.organizationId,
        identity_id: invitation.value.identityId,
        invitation_id: invitation.value.id,
        role: invitation.value.role,
        expires_at: invitation.value.expiresAt.toISOString(),
      },
      { kind: 'invitation', id: invitation.value.id },
      invitation.value.organizationId,
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      invitation: invitation.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'invitation.commit'));

    return ok({
      invitationId: invitation.value.id,
      identityId: invitation.value.identityId,
      role: invitation.value.role,
      status: 'pending',
      expiresAt: invitation.value.expiresAt,
    });
  }
}
