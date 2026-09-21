import { parse, type ID } from '../id/index.js';
import {
  reference,
  validReferenceKind,
  type Reference,
} from './reference.js';

export interface IncomingHints {
  correlation?: string;
  causation?: { kind: string; id: string };
}

export type Disposition = 'fresh' | 'continued' | 'restarted';

export interface Issue {
  readonly field: 'correlation' | 'causation';
  readonly reason: 'invalid_id' | 'invalid_kind' | 'missing_correlation';
}

const token = Symbol('incoming');
const known = new WeakSet<object>();

export class IncomingResult {
  readonly #issues: readonly Readonly<Issue>[];

  constructor(
    key: typeof token,
    readonly decision: Disposition,
    readonly correlation: ID | undefined,
    readonly cause: Reference | undefined,
    issues: Issue[],
  ) {
    if (key !== token) throw new TypeError('use inspectIncoming');
    this.#issues = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue })),
    );
    known.add(this);
    Object.freeze(this);
  }

  issues(): Issue[] {
    return this.#issues.map((issue) => ({ ...issue }));
  }
}

export const validIncoming = (value: unknown): value is IncomingResult =>
  typeof value === 'object' && value !== null && known.has(value);

export function inspectIncoming(hints: IncomingHints): IncomingResult {
  let decision: Disposition = 'fresh';
  let correlation: ID | undefined;
  let cause: Reference | undefined;
  const issues: Issue[] = [];

  if (hints.correlation === undefined && hints.causation === undefined) {
    return new IncomingResult(token, decision, correlation, cause, issues);
  }

  decision = 'restarted';
  if (hints.correlation !== undefined) {
    const result = parse(hints.correlation);
    if (result.ok) {
      correlation = result.value;
      decision = 'continued';
    } else {
      issues.push({ field: 'correlation', reason: 'invalid_id' });
    }
  }

  if (hints.causation !== undefined) {
    const candidate = hints.causation;
    if (!candidate || !validReferenceKind(candidate.kind)) {
      issues.push({ field: 'causation', reason: 'invalid_kind' });
    } else {
      const result = parse(candidate.id);
      if (!result.ok) {
        issues.push({ field: 'causation', reason: 'invalid_id' });
      } else if (correlation === undefined) {
        issues.push({ field: 'causation', reason: 'missing_correlation' });
      } else {
        const created = reference(candidate.kind, result.value);
        if (created.ok) cause = created.value;
      }
    }
  }

  return new IncomingResult(token, decision, correlation, cause, issues);
}
