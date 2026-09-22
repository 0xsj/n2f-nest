import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Gate } from '../../shared/health/index.js';
import { HEALTH_GATE } from './health.tokens.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_GATE) private readonly gate: Gate) {}

  @Get()
  ready(): Promise<{ status: 'ready' }> {
    return this.readiness();
  }

  @Get('live')
  live(): { status: 'live' } {
    return { status: 'live' };
  }

  @Get('ready')
  readiness(): Promise<{ status: 'ready' }> {
    return this.gate.ready().then((ready) => {
      if (!ready) throw new ServiceUnavailableException({ status: 'not_ready' });
      return { status: 'ready' };
    });
  }
}
