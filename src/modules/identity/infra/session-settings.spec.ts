import { describe, expect, it } from 'vitest';
import { map } from '../../../shared/env/index.js';
import { sessionSettings } from './session-settings.js';

describe('sessionSettings', () => {
  it('defaults to a 24-hour lifetime, 60-minute idle timeout, 10 sessions and 7 days of retention', () => {
    expect(sessionSettings(map({}))).toEqual({
      lifetimeMs: 24 * 3600 * 1000,
      idleTimeoutMs: 60 * 60 * 1000,
      maxActivePerIdentity: 10,
      retentionMs: 7 * 24 * 3600 * 1000,
    });
  });

  it('reads each limit from the environment', () => {
    expect(
      sessionSettings(
        map({
          N2F_SESSION_LIFETIME_HOURS: '8',
          N2F_SESSION_IDLE_MINUTES: '15',
          N2F_SESSION_MAX_PER_IDENTITY: '3',
          N2F_SESSION_RETENTION_DAYS: '0',
        }),
      ),
    ).toEqual({ lifetimeMs: 8 * 3600 * 1000, idleTimeoutMs: 15 * 60 * 1000, maxActivePerIdentity: 3, retentionMs: 0 });
  });

  it('stops startup on an invalid limit, naming the variable', () => {
    expect(() => sessionSettings(map({ N2F_SESSION_MAX_PER_IDENTITY: '0' }))).toThrow(
      'N2F_SESSION_MAX_PER_IDENTITY',
    );
    expect(() => sessionSettings(map({ N2F_SESSION_IDLE_MINUTES: 'soon' }))).toThrow('N2F_SESSION_IDLE_MINUTES');
  });
});
