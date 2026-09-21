/** HTTP values and consumer-owned observation policy; frameworks live in adapters. */
export { Active, type Completion } from './lifecycle.js';
export { problemOf, type Problem } from './problem.js';
export {
  classifyCompletion,
  normalizeMethod,
  type Classification,
  type CompletionFacts,
  type Outcome,
  type Termination,
} from './policy.js';
export { decodeObject, invalidBody, stringFields } from './json.js';
export {
  allowFor,
  METHODS,
  parseCookies,
  REPLY_HEADERS,
  Refuse,
  Reply,
  SELECTED_HEADERS,
  serializeCookie,
  type Admission,
  type CookieValue,
  type FeatureRequest,
  type Method,
  type ReplyHeader,
  type ReplySpec,
  type ReplyStatus,
  type SelectedHeader,
} from './feature.js';
