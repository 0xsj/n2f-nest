import { describe, expect, it } from 'vitest';
import { drainAndClose } from './shutdown.js';

describe('drainAndClose', () => {
  it('reports not-ready, waits for routing to drain, then closes', async () => {
    const steps: string[] = [];
    await drainAndClose(
      { close: async () => void steps.push('close') },
      { drain: () => void steps.push('drain') },
      5000,
      async (milliseconds) => void steps.push(`wait ${milliseconds}`),
    );

    expect(steps).toEqual(['drain', 'wait 5000', 'close']);
  });

  it('closes immediately when no drain period is configured', async () => {
    const steps: string[] = [];
    await drainAndClose(
      { close: async () => void steps.push('close') },
      { drain: () => void steps.push('drain') },
      0,
      async () => void steps.push('wait'),
    );

    expect(steps).toEqual(['drain', 'close']);
  });
});
