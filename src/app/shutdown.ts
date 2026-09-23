import type { INestApplication } from '@nestjs/common';
import type { Gate } from '../shared/health/index.js';

type Clock = (milliseconds: number) => Promise<void>;

const wait: Clock = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Stop in the order a load balancer needs: report not-ready while still
 * serving, wait `drainMs` for routing to move away, then close the
 * application (workers, HTTP server, connections). Nest's own shutdown hooks
 * close the server before readiness changes, so main.ts uses this instead.
 */
export async function drainAndClose(
  app: Pick<INestApplication, 'close'>,
  gate: Pick<Gate, 'drain'>,
  drainMs: number,
  sleep: Clock = wait,
): Promise<void> {
  gate.drain();
  if (drainMs > 0) await sleep(drainMs);
  await app.close();
}

/** Run `drainAndClose` once on the first SIGTERM or SIGINT. */
export function closeOnSignals(
  app: Pick<INestApplication, 'close'>,
  gate: Pick<Gate, 'drain'>,
  drainMs: number,
  onError: (error: unknown) => void,
): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    drainAndClose(app, gate, drainMs).then(
      () => process.exit(0),
      (error: unknown) => {
        onError(error);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
