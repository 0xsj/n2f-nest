import { err, ok, type Failure, type Result } from '../errors/index.js';
import {
  identityValid,
  invalid,
  namedActor,
  validActor,
  type Actor,
} from './actor.js';

export interface AttributionSpec {
  initiator?: Actor;
  onBehalfOf?: Actor;
  tenant?: string;
}

export type Attribution = Readonly<AttributionSpec>;

const known = new WeakSet<object>();

export function attribution(
  spec: AttributionSpec = {},
): Result<Attribution, Failure> {
  if (spec.initiator !== undefined && !validActor(spec.initiator)) {
    return err(invalid('invalid_attribution'));
  }

  if (
    spec.onBehalfOf !== undefined &&
    (!namedActor(spec.initiator) ||
      !namedActor(spec.onBehalfOf) ||
      (spec.initiator.kind === spec.onBehalfOf.kind &&
        spec.initiator.identity === spec.onBehalfOf.identity))
  ) {
    return err(invalid('invalid_attribution'));
  }

  if (spec.tenant !== undefined && !identityValid(spec.tenant)) {
    return err(invalid('invalid_attribution'));
  }

  const value = Object.freeze({
    initiator: spec.initiator,
    onBehalfOf: spec.onBehalfOf,
    tenant: spec.tenant,
  });
  known.add(value);
  return ok(value);
}

export const validAttribution = (value: unknown): value is Attribution =>
  typeof value === 'object' && value !== null && known.has(value);
