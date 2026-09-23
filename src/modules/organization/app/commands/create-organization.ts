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
  ORGANIZATION_EVENT_TYPES,
  Membership,
  Organization,
} from '../../domain/index.js';
import type { CurrentActorReader, OrganizationWriter } from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type OrganizationApplicationFailure,
} from '../failures.js';

export type CreateOrganizationCommand = Readonly<{
  sessionToken: SecretString;
  name: unknown;
  slug: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type CreateOrganizationResult = Readonly<{
  organizationId: ID;
  ownerMembershipId: ID;
}>;

export type CreateOrganizationDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  actors: CurrentActorReader;
  writer: OrganizationWriter;
}>;

function nextId(ids: IDGenerator): Result<ID, OrganizationApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error, 'organization.id_generation'));
}

function operationFailure(work: WorkContext): OrganizationApplicationFailure | undefined {
  return work.snapshot().operation === 'organization.create'
    ? undefined
    : failure('invalid', 'organization work operation is invalid', {
        type: 'organization.invalid_operation',
      });
}

export class CreateOrganization {
  constructor(private readonly dependencies: CreateOrganizationDependencies) {}

  async execute(
    command: CreateOrganizationCommand,
  ): Promise<Result<CreateOrganizationResult, OrganizationApplicationFailure>> {
    const operation = operationFailure(command.work);
    if (operation) return err(operation);

    const actor = await this.dependencies.actors.findCurrent(
      command.sessionToken,
      command.signal,
    );
    if (!actor.ok) return err(dependencyFailure(actor.error, 'identity.current.find'));

    const createdAt = this.dependencies.clock.now();
    const organizationId = nextId(this.dependencies.ids);
    if (!organizationId.ok) return organizationId;

    const organization = Organization.create({
      id: organizationId.value,
      name: command.name,
      slug: command.slug,
      createdAt,
    });
    if (!organization.ok) return organization;

    const membershipId = nextId(this.dependencies.ids);
    if (!membershipId.ok) return membershipId;

    const membership = Membership.add({
      id: membershipId.value,
      organizationId: organization.value.id,
      identityId: actor.value.identityId,
      role: 'owner',
      createdAt,
    });
    if (!membership.ok) return membership;

    const organizationEventId = nextId(this.dependencies.ids);
    if (!organizationEventId.ok) return organizationEventId;

    const organizationEvent = Envelope.create(
      organizationEventId.value,
      ORGANIZATION_EVENT_TYPES.created,
      createdAt.getTime(),
      command.work,
      {
        organization_id: organization.value.id,
        identity_id: actor.value.identityId,
        name: organization.value.name,
        slug: organization.value.slug,
      },
      { kind: 'organization', id: organization.value.id },
      organization.value.id,
    );
    if (!organizationEvent.ok) return err(dependencyFailure(organizationEvent.error, 'event.create'));

    const membershipEventId = nextId(this.dependencies.ids);
    if (!membershipEventId.ok) return membershipEventId;

    const membershipEvent = Envelope.create(
      membershipEventId.value,
      MEMBERSHIP_EVENT_TYPES.added,
      createdAt.getTime(),
      command.work,
      {
        organization_id: organization.value.id,
        identity_id: actor.value.identityId,
        membership_id: membership.value.id,
        role: membership.value.role,
      },
      { kind: 'membership', id: membership.value.id },
      organization.value.id,
    );
    if (!membershipEvent.ok) return err(dependencyFailure(membershipEvent.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      organization: organization.value,
      ownerMembership: membership.value,
      events: [organizationEvent.value, membershipEvent.value],
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'organization.commit'));

    return ok({
      organizationId: organization.value.id,
      ownerMembershipId: membership.value.id,
    });
  }
}
