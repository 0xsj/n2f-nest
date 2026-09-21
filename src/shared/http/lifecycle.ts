import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../errors/index.js';
import {
  classifyCompletion,
  type Classification,
  type CompletionFacts,
} from './policy.js';

export type Completion = Readonly<{
  facts: CompletionFacts;
  classification: Classification;
  elapsedNs: bigint;
}>;

/** Native owner supplies monotonic time and independent nonblocking outputs. */
export class Active {
  readonly #started: bigint;
  readonly #now: () => bigint;
  readonly #outputs: readonly ((completion: Completion) => void)[];
  #done = false;
  #failed = 0;

  constructor(
    now: () => bigint,
    outputs: readonly ((completion: Completion) => void)[],
  ) {
    this.#now = now;
    this.#started = now();
    this.#outputs = [...outputs];
  }

  finish(facts: CompletionFacts): Result<boolean, Failure> {
    const classification = classifyCompletion(facts);
    if (!classification.ok) return classification;
    if (this.#done) return ok(false);
    const elapsedNs = this.#now() - this.#started;
    if (elapsedNs < 0n) {
      return err(
        failure('invalid', 'invalid observation duration', {
          type: 'telemetry.invalid_duration',
        }),
      );
    }
    this.#done = true;
    const completion = Object.freeze({
      facts: Object.freeze({ ...facts }),
      classification: Object.freeze({ ...classification.value }),
      elapsedNs,
    });
    for (const output of this.#outputs) {
      try {
        output(completion);
      } catch {
        this.#failed += 1;
      }
    }
    return ok(true);
  }

  get failedAttempts(): number {
    return this.#failed;
  }
}
