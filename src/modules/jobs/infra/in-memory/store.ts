import type { Job, JobSubject } from '../../domain/index.js';

export class InMemoryJobStore {
  readonly #jobs = new Map<string, Job>();

  jobById(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  jobBySubject(
    organizationId: string,
    kind: string,
    subject: JobSubject,
  ): Job | undefined {
    return [...this.#jobs.values()].find(
      (job) =>
        job.organizationId === organizationId &&
        job.kind === kind &&
        job.subject?.type === subject.type &&
        job.subject?.id === subject.id,
    );
  }

  jobsForOrganization(organizationId: string): readonly Job[] {
    return [...this.#jobs.values()]
      .filter((job) => job.organizationId === organizationId)
      .sort((left, right) => {
        const time = left.createdAt.getTime() - right.createdAt.getTime();
        return time === 0 ? left.id.localeCompare(right.id) : time;
      });
  }

  add(job: Job): void { this.#jobs.set(job.id, job); }
  replace(job: Job): void { this.#jobs.set(job.id, job); }
  remove(id: string): void { this.#jobs.delete(id); }
}
