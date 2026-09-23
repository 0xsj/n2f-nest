/**
 * Document commands other code may issue. Only workflows may import this
 * file: commands cross module boundaries only through a workflow.
 */
export {
  BeginDocumentProcessing,
  CompleteDocumentProcessing,
  FailDocumentProcessing,
  RetryDocumentProcessing,
  type ProcessDocumentResult,
} from './app/index.js';
