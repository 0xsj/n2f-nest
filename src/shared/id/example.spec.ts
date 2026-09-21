import { expect, it } from 'vitest';
import { FakeClock } from '../clock/index.js';
import { V7 } from './index.js';

it('keeps UUIDv7 order stable when wall time moves backward', () => {
  const clock = new FakeClock(new Date(0x0123456789ab));
  const generator = new V7(clock, (bytes) => {
    bytes.fill(0);
  });

  const first = generator.newId();
  if (!first.ok) throw new Error(first.error.message);

  clock.advance(25);
  clock.set(new Date(0x0123456789aa));
  const second = generator.newId();
  if (!second.ok) throw new Error(second.error.message);

  const output = [
    first.value,
    second.value,
    `${clock.elapsed() / 1000000n}ms`,
  ];
  expect(output).toEqual([
    '01234567-89ab-7000-8000-000000000000',
    '01234567-89ab-7001-8000-000000000000',
    '25ms',
  ]);
});
