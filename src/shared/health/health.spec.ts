import { expect, it } from 'vitest';
import { ok } from '../errors/index.js';
import { Gate } from './index.js';

it('owns startup, drain and bounded readiness probes', async () => {
  const gate = new Gate(10, []);
  expect(await gate.ready()).toBe(false);
  expect(gate.start()).toBe(true);
  expect(gate.start()).toBe(false);
  expect(await gate.ready()).toBe(true);
  gate.drain();
  expect(await gate.ready()).toBe(false);
  expect(gate.start()).toBe(false);

  let calls = 0;
  let release!: () => void;
  const hanging = new Gate(10, [
    async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ok(undefined);
    },
  ]);
  hanging.start();
  expect(await hanging.ready()).toBe(false);
  expect(await hanging.ready()).toBe(false);
  expect(calls).toBe(1);
  release();

  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let unblock!: () => void;
  const draining = new Gate(1000, [
    async () => {
      entered();
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      return ok(undefined);
    },
  ]);
  draining.start();
  const task = draining.ready();
  await started;
  draining.drain();
  unblock();
  expect(await task).toBe(false);
});
