/**
 * Shared execution attribution and causality values.
 *
 * Provenance records who initiated or executed work, which logical work an
 * execution belongs to, what caused it and how it relates to a known lineage.
 * It does not authorize actors, authenticate remote snapshots, persist records,
 * propagate transport headers or claim that work committed successfully.
 */
export {
  actor,
  anonymous,
  type Actor,
  type ActorKind,
} from './actor.js';
export {
  attribution,
  type Attribution,
  type AttributionSpec,
} from './attribution.js';
export { operation, type Operation } from './operation.js';
export {
  reference,
  type Reference,
  type ReferenceKind,
} from './reference.js';
export {
  LinkSet,
  linkSet,
  type Link,
  type Relation,
} from './links.js';
export {
  IncomingResult,
  inspectIncoming,
  type Disposition,
  type IncomingHints,
  type Issue,
} from './incoming.js';
export {
  restoreWork,
  WorkContext,
  type CorrelationSource,
  type DraftWork,
  type Origin,
  type ReplayInfo,
  type WorkSnapshot,
} from './work.js';
export {
  restoreScope,
  Scope,
  type ScopeSnapshot,
} from './scope.js';
export {
  Factory,
  prepare,
  type ExecutionSpec,
  type ReplaySpec,
  type RootSpec,
  type StepSpec,
  type WorkSpec,
} from './factory.js';
