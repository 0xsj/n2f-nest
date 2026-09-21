import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';

export const invalid = (code: string): Failure =>
  failure('invalid', 'invalid provenance', { type: `provenance.${code}` });

export type ActorKind = 'anonymous' | 'user' | 'service' | 'system';

export interface Actor {
  readonly kind: ActorKind;
  readonly identity?: string;
}

const actors = new WeakSet<object>();

export const identityValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,128}$/.test(value);

export function actor(
  kind: ActorKind,
  identity: string,
): Result<Actor, Failure> {
  if (
    (kind === 'anonymous' && identity !== '') ||
    (kind !== 'anonymous' &&
      (!['user', 'service', 'system'].includes(kind) ||
        !identityValid(identity)))
  ) {
    return err(invalid('invalid_actor'));
  }

  const value = Object.freeze(
    kind === 'anonymous' ? { kind } : { kind, identity },
  );
  actors.add(value);
  return ok(value);
}

export function anonymous(): Actor {
  const value: Actor = Object.freeze({ kind: 'anonymous' });
  actors.add(value);
  return value;
}

export const validActor = (value: unknown): value is Actor =>
  typeof value === 'object' && value !== null && actors.has(value);

export const namedActor = (value: unknown): value is Actor =>
  validActor(value) && value.kind !== 'anonymous';
