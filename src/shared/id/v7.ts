import { randomFillSync } from 'node:crypto';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import type { WallClock } from '../clock/index.js';
import { encodeV7, type ID } from './value.js';

/** Fill every byte synchronously; production sources must be cryptographic. */
export type Entropy = (bytes: Uint8Array) => void;

/** Capability consumed by provenance and other owners that mint IDs. */
export interface IDGenerator {
  newId(): Result<ID, Failure>;
}

const osEntropy: Entropy = (bytes) => {
  randomFillSync(bytes);
};

/** Ordering belongs to this generator instance within one JavaScript isolate. */
export class V7 implements IDGenerator {
  #last: number | undefined;
  #counter = 0;

  constructor(
    private readonly clock: WallClock,
    private readonly entropy: Entropy = osEntropy,
  ) {}

  newId(): Result<ID, Failure> {
    let milliseconds = this.clock.now().getTime();
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 281474976710655
    ) {
      return err(
        failure('invalid', 'ID timestamp out of range', {
          type: 'id.time_range',
        }),
      );
    }

    const fresh = this.#last === undefined || milliseconds > this.#last;
    let counter = 0;
    if (!fresh) {
      milliseconds = this.#last!;
      if (this.#counter === 4095) {
        return err(
          failure('unavailable', 'ID counter exhausted', {
            type: 'id.exhausted',
          }),
        );
      }
      counter = this.#counter + 1;
    }

    const random = new Uint8Array(10);
    try {
      this.entropy(random);
    } catch (cause) {
      return err(
        failure('unavailable', 'ID entropy unavailable', {
          type: 'id.entropy',
          cause,
        }),
      );
    }

    if (fresh) counter = ((random[0] << 8) | random[1]) & 0x07ff;
    const value = encodeV7(milliseconds, counter, random.subarray(2));

    this.#last = milliseconds;
    this.#counter = counter;
    return ok(value);
  }
}
