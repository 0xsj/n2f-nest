import {
  err,
  failure,
  ok,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import {
  MEMBERSHIP_EVENT_TYPES,
  Membership,
  type MembershipRole,
} from '../../domain/index.js';
import type {
  CurrentActorReader,
  IdentityReferenceReader,
  MembershipReader,
  MembershipWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type OrganizationApplicationFailure,
} from '../failures.js';

export type AddMembershipCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  identityId: ID;
  role: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type AddMembershipDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  actors: CurrentActorReader;
  identities: IdentityReferenceReader;
  memberships: MembershipReader;
  writer: MembershipWriter;
}>;

export type AddMembershipResult = Readonly<{
  membershipId: ID;
  identityId: ID;
  role: MembershipRole;
}>;

function nextId(ids: IDGenerator): Result<ID, OrganizationApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error, 'organization.membership.id_generation'));
}

function operationFailure(work: WorkContext): OrganizationApplicationFailure | undefined {
  return work.snapshot().operation === 'organization.membership.add'
    ? undefined
    : failure('invalid', 'membership add operation is invalid', {
        type: 'organization.membership.invalid_operation',
      });
}

function forbidden(): OrganizationApplicationFailure {
  return failure('forbidden', 'only an organization owner can add members', {
    type: 'organization.membership.add_forbidden',
  });
}

export class AddMembership {
  constructor(private readonly dependencies: AddMembershipDependencies) {}

  async execute(
    command: AddMembershipCommand,
  ): Promise<Result<AddMembershipResult, OrganizationApplicationFailure>> {
    const operation = operationFailure(command.work);
    if (operation) return err(operation);

    const actor = await this.dependencies.actors.findCurrent(
      command.sessionToken,
      command.signal,
    );
    if (!actor.ok) return err(dependencyFailure(actor.error, 'identity.current.find'));

    const organizationMembership =
      await this.dependencies.memberships.findActiveForIdentity(
        command.organizationId,
        actor.value.identityId,
        command.signal,
      );
    if (!organizationMembership.ok) return err(dependencyFailure(organizationMembership.error, 'membership.findActiveForIdentity'));
    if (
      organizationMembership.value === null ||
      organizationMembership.value.role !== 'owner'
    ) {
      return err(forbidden());
    }

    const identity = await this.dependencies.identities.findActive(
      command.identityId,
      command.signal,
    );
    if (!identity.ok) return err(dependencyFailure(identity.error, 'identity.findActive'));
    if (identity.value === null) {
      return err(
        failure('not_found', 'active identity was not found', {
          type: 'organization.membership.identity_not_found',
        }),
      );
    }

    const existing = await this.dependencies.memberships.findForIdentity(
      command.organizationId,
      command.identityId,
      command.signal,
    );
    if (!existing.ok) return err(dependencyFailure(existing.error, 'membership.findForIdentity'));
    if (existing.value !== null) {
      return err(
        failure(
          'conflict',
          'identity is already associated with organization',
          {
            type: 'organization.membership.already_exists',
          },
        ),
      );
    }

    const membershipId = nextId(this.dependencies.ids);
    if (!membershipId.ok) return membershipId;
    const createdAt = this.dependencies.clock.now();
    const membership = Membership.add({
      id: membershipId.value,
      organizationId: command.organizationId,
      identityId: command.identityId,
      role: command.role,
      createdAt,
    });
    if (!membership.ok) return membership;

    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;
    const event = Envelope.create(
      eventId.value,
      MEMBERSHIP_EVENT_TYPES.added,
      createdAt.getTime(),
      command.work,
      {
        organization_id: membership.value.organizationId,
        identity_id: membership.value.identityId,
        membership_id: membership.value.id,
        role: membership.value.role,
      },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      membership: membership.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'membership.commit'));

    return ok({
      membershipId: membership.value.id,
      identityId: membership.value.identityId,
      role: membership.value.role,
    });
  }
}
