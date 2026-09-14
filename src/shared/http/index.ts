/** HTTP values and consumer-owned observation policy; frameworks live in adapters. */
export { Active, type Completion } from './lifecycle.js';
export { problemOf, type Problem } from './problem.js';
export {
  classifyCompletion,
  normalizeMethod,
  type Outcome,
  type Termination,
  type CompletionFacts,
  type Classification,
} from './policy.js';
export {
  parseCookies,
  serializeCookie,
  allowFor,
  Refuse,
  Reply,
  METHODS,
  SELECTED_HEADERS,
  REPLY_HEADERS,
  type Method,
  type FeatureRequest,
  type Admission,
  type CookieValue,
  type ReplySpec,
  type ReplyStatus,
  type ReplyHeader,
  type SelectedHeader,
} from './feature.js';
