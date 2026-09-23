import type { Job, JobSubject } from '../../domain/index.js';

export class InMemoryJobStore {
  readonly #jobs = new Map<string, Job>();

  jobById(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  openJobBySubject(
    organizationId: string,
    kind: string,
    subject: JobSubject,
  ): Job | undefined {
    return [...this.#jobs.values()].find(
      (job) =>
        job.open &&
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

  runningStartedBefore(startedBefore: Date, limit: number): readonly Job[] {
    return [...this.#jobs.values()]
      .filter(
        (job) =>
          job.status === 'running' &&
          job.startedAt !== null &&
          job.startedAt.getTime() < startedBefore.getTime(),
      )
      .sort((left, right) => left.startedAt!.getTime() - right.startedAt!.getTime())
      .slice(0, limit);
  }

  add(job: Job): void { this.#jobs.set(job.id, job); }
  replace(job: Job): void { this.#jobs.set(job.id, job); }
  remove(id: string): void { this.#jobs.delete(id); }
}
