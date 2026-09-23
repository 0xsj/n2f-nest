import { Injectable } from '@nestjs/common';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../shared/errors/index.js';
import type { ID } from '../../../shared/id/index.js';
import {
  actor,
  Factory as ProvenanceFactory,
  operation,
  type WorkContext,
} from '../../../shared/provenance/index.js';
import type { SecretString } from '../../../shared/secret/index.js';
import {
  BeginDocumentProcessing,
  type ProcessDocumentResult,
} from '../../../modules/document/commands.js';
import {
  SubmitWorkflowJob,
  type SubmitWorkflowJobResult,
} from '../../../modules/jobs/commands.js';
import { DOCUMENT_PROCESSING_JOB_KIND } from '../infra/job-events.js';
import { GetOrganizationMembership } from '../../../modules/organization/api.js';
import { CheckDocumentProcessable } from '../../../modules/document/api.js';

export type RequestDocumentProcessingCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  documentId: ID;
  maxAttempts?: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type RequestDocumentProcessingDependencies = Readonly<{
  membership: GetOrganizationMembership;
  processable: CheckDocumentProcessable;
  factory: ProvenanceFactory;
  begin: BeginDocumentProcessing;
  submit: SubmitWorkflowJob;
}>;

export type RequestDocumentProcessingResult = Readonly<{
  documentId: ID;
  jobId: ID;
  documentStatus: ProcessDocumentResult['status'];
  jobStatus: SubmitWorkflowJobResult['status'];
  jobCreated: boolean;
}>;

function childWork(
  factory: ProvenanceFactory,
  parent: WorkContext,
  operationName: string,
): Result<WorkContext, Failure> {
  const operationValue = operation(operationName);
  if (!operationValue.ok) return operationValue;
  const executor = actor('service', 'n2f-nest-document-processing');
  if (!executor.ok) return executor;
  const execution = factory.execute(parent, { executor: executor.value, attempt: 1 });
  if (!execution.ok) return execution;
  const child = factory.child(execution.value, {
    operation: operationValue.value,
    executor: executor.value,
  });
  return child.ok ? { ok: true, value: child.value.workContext() } : child;
}

@Injectable()
export class RequestDocumentProcessing {
  constructor(
    private readonly dependencies: RequestDocumentProcessingDependencies,
  ) {}

  async execute(
    command: RequestDocumentProcessingCommand,
  ): Promise<Result<RequestDocumentProcessingResult, Failure>> {
    if (command.work.snapshot().operation !== 'document.processing.request') {
      return err(
        failure('invalid', 'document processing request operation is invalid', {
          type: 'document.processing.invalid_operation',
        }),
      );
    }

    const membership = await this.dependencies.membership.execute({
      sessionToken: command.sessionToken,
      organizationId: command.organizationId,
      signal: command.signal,
    });
    if (!membership.ok) return membership;
    if (
      membership.value === null ||
      membership.value.organization.status !== 'active' ||
      membership.value.membership.status !== 'active'
    ) {
      return err(
        failure('forbidden', 'organization access is required', {
          type: 'document.processing_forbidden',
        }),
      );
    }
    if (
      membership.value.membership.role !== 'owner' &&
      membership.value.membership.role !== 'admin'
    ) {
      return err(
        failure('forbidden', 'only organization owners and admins can process documents', {
          type: 'document.processing_forbidden',
        }),
      );
    }

    // Refuse before creating work for a document that cannot be processed.
    const processable = await this.dependencies.processable.execute({
      organizationId: command.organizationId,
      documentId: command.documentId,
      signal: command.signal,
    });
    if (!processable.ok) return processable;

    // Ensure the document's open job first: its ID names the processing run
    // the document then waits on, so outcomes of any older job are stale.
    const jobWork = childWork(
      this.dependencies.factory,
      command.work,
      'job.submit.workflow',
    );
    if (!jobWork.ok) return jobWork;
    const submitted = await this.dependencies.submit.execute({
      organizationId: command.organizationId,
      kind: DOCUMENT_PROCESSING_JOB_KIND,
      subject: { type: 'document', id: command.documentId },
      maxAttempts: command.maxAttempts,
      work: jobWork.value,
      signal: command.signal,
    });
    if (!submitted.ok) return submitted;

    const beginWork = childWork(
      this.dependencies.factory,
      jobWork.value,
      'document.processing.start',
    );
    if (!beginWork.ok) return beginWork;
    // A failure here leaves an open job whose outcomes this document ignores;
    // repeating the request reuses that job and begins its run.
    const begun = await this.dependencies.begin.execute({
      organizationId: command.organizationId,
      documentId: command.documentId,
      processingRun: submitted.value.jobId,
      work: beginWork.value,
      signal: command.signal,
    });
    if (!begun.ok) return begun;

    return ok({
      documentId: begun.value.documentId,
      jobId: submitted.value.jobId,
      documentStatus: begun.value.status,
      jobStatus: submitted.value.status,
      jobCreated: submitted.value.created,
    });
  }
}
