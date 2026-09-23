import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../../../platform/runtime/index.js';
import type { ListAuditEntries } from '../../app/index.js';
import { AuditController } from './audit.controller.js';

describe('AuditController', () => {
  it('hides the cross-tenant listing unless development endpoints are enabled', async () => {
    const list = { execute: vi.fn() };
    const config = { http: { trustProxy: false, devEndpoints: false } } as RuntimeConfig;
    const controller = new AuditController(list as unknown as ListAuditEntries, config);

    const response = controller.entries();

    await expect(response).rejects.toBeInstanceOf(HttpException);
    await response.catch((error: HttpException) => {
      expect(error.getStatus()).toBe(404);
    });
    expect(list.execute).not.toHaveBeenCalled();
  });
});
