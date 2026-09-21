import { SecretString } from '../secret/index.js';

export type Fields = Readonly<Record<string, unknown>>;

/**
 * Snapshot only plain data. Getters, custom prototypes, cycles and unsupported
 * values are refused rather than being rendered as a disclosure fallback.
 */
export function snapshot(
  value: unknown,
  parents = new Set<object>(),
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof SecretString) return '[REDACTED]';
  if (typeof value !== 'object' || parents.has(value)) {
    throw new TypeError('unsupported log field');
  }

  parents.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('unsupported log field');
          }
          return snapshot(descriptor.value, parents);
        }),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('unsupported log field');
    }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([, descriptor]) => descriptor.enumerable)
      .map(([key, descriptor]) => {
        if (!Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('unsupported log field');
        }
        return [key, snapshot(descriptor.value, parents)];
      });
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    parents.delete(value);
  }
}
