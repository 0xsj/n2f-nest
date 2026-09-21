import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import { SecretString } from '../secret/index.js';
import type { Lookup } from './lookup.js';
import { integer, validKey } from './parse.js';

export interface Var {
  key: string;
  value: string;
  source: 'environment' | 'default';
  secret: boolean;
}

export class Reader {
  readonly #seen = new Set<string>();
  readonly #problems = new Map<string, string>();
  readonly #resolved: Var[] = [];

  constructor(private readonly lookup: Lookup) {}

  #problem(key: string, reason: string): void {
    this.#problems.set(validKey(key) ? key : '<key>', reason);
  }

  #read(
    key: string,
  ): { valid: true; value: string | undefined } | { valid: false } {
    if (!validKey(key)) {
      this.#problem(key, 'invalid_key');
      return { valid: false };
    }
    if (this.#seen.has(key)) {
      this.#problem(key, 'duplicate_key');
      return { valid: false };
    }
    this.#seen.add(key);
    const value = this.lookup(key);
    if (value !== undefined && typeof value !== 'string') {
      this.#problem(key, 'invalid_source');
      return { valid: false };
    }
    return { valid: true, value };
  }

  #record(
    key: string,
    value: string,
    present: boolean,
    secret = false,
  ): void {
    this.#resolved.push({
      key,
      value: secret ? '[REDACTED]' : value,
      source: present ? 'environment' : 'default',
      secret,
    });
  }

  string(key: string, fallback: string): string {
    const result = this.#read(key);
    if (!result.valid) return '';
    const value = result.value ?? fallback;
    this.#record(key, value, result.value !== undefined);
    return value;
  }

  required(key: string): string {
    const result = this.#read(key);
    if (!result.valid) return '';
    if (result.value === undefined || result.value === '') {
      this.#problem(key, 'required');
      return '';
    }
    this.#record(key, result.value, true);
    return result.value;
  }

  secret(key: string): SecretString {
    const result = this.#read(key);
    if (!result.valid) return new SecretString('');
    if (result.value === undefined || result.value === '') {
      this.#problem(key, 'required');
      return new SecretString('');
    }
    this.#record(key, result.value, true, true);
    return new SecretString(result.value);
  }

  int(key: string, fallback: number, min: number, max: number): number {
    if (
      ![fallback, min, max].every(Number.isSafeInteger) ||
      min > max ||
      fallback < min ||
      fallback > max
    ) {
      this.#problem(key, 'invalid_definition');
      return 0;
    }

    const result = this.#read(key);
    if (!result.valid) return 0;
    const value =
      result.value === undefined ? fallback : integer(result.value);
    if (value === undefined) {
      this.#problem(key, 'invalid_integer');
      return 0;
    }
    if (value < min || value > max) {
      this.#problem(key, 'out_of_range');
      return 0;
    }
    this.#record(key, String(value), result.value !== undefined);
    return value;
  }

  boolean(key: string, fallback: boolean): boolean {
    const result = this.#read(key);
    if (!result.valid) return false;
    let value = fallback;
    if (result.value !== undefined) {
      if (result.value !== 'true' && result.value !== 'false') {
        this.#problem(key, 'invalid_boolean');
        return false;
      }
      value = result.value === 'true';
    }
    this.#record(key, String(value), result.value !== undefined);
    return value;
  }

  enumeration(
    key: string,
    fallback: string,
    allowed: readonly string[],
  ): string {
    const choices = new Set(allowed);
    if (
      choices.size !== allowed.length ||
      choices.has('') ||
      !choices.has(fallback)
    ) {
      this.#problem(key, 'invalid_definition');
      return '';
    }

    const result = this.#read(key);
    if (!result.valid) return '';
    const value = result.value ?? fallback;
    if (!choices.has(value)) {
      this.#problem(key, 'invalid_choice');
      return '';
    }
    this.#record(key, value, result.value !== undefined);
    return value;
  }

  check(): Result<void, Failure> {
    return this.#problems.size
      ? err(
          failure('invalid', 'invalid configuration', {
            type: 'env.invalid',
            fields: Object.fromEntries(this.#problems),
          }),
        )
      : ok(undefined);
  }

  manifest(): Result<Var[], Failure> {
    const result = this.check();
    return result.ok
      ? ok(
          this.#resolved
            .map((value) => ({ ...value }))
            .sort((a, b) =>
              a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
            ),
        )
      : result;
  }
}
