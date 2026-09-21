import { expect, it } from 'vitest';
import { actor, attribution, operation } from './index.js';

it('rejects line terminators in identities, tenants and operations', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    expect(actor('service', `api${suffix}`).ok).toBe(false);
    expect(attribution({ tenant: `tenant${suffix}` }).ok).toBe(false);
    expect(operation(`demo.run${suffix}`).ok).toBe(false);
  }
});
