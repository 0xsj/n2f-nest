import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { err, failure } from '../../shared/errors/index.js';
import { Gate, type Check } from '../../shared/health/index.js';
import { Broker } from '../../shared/events/nats/index.js';
import { Database } from '../../shared/postgres/index.js';
import {
  DATABASE,
  NATS_BROKER,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../runtime/index.js';
import { HealthController } from './health.controller.js';
import { HEALTH_GATE } from './health.tokens.js';

function missingDependency(name: string) {
  return err(
    failure('unavailable', `${name} is not initialized`, {
      type: 'health.dependency_unavailable',
      fields: { dependency: name },
    }),
  );
}

function checksFor(
  config: RuntimeConfig,
  database: Database | undefined,
  broker: Broker | undefined,
): readonly Check[] {
  const checks: Check[] = [];

  if (config.storage === 'postgres') {
    checks.push((signal) =>
      database ? database.ping(signal) : Promise.resolve(missingDependency('postgres')),
    );
  }

  if (config.eventTransport === 'nats') {
    checks.push((signal) =>
      broker ? broker.ping(signal) : Promise.resolve(missingDependency('nats')),
    );
  }

  return checks;
}

@Injectable()
class HealthLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Health');

  constructor(@Inject(HEALTH_GATE) private readonly gate: Gate) {}

  onApplicationBootstrap(): void {
    this.gate.start();
    this.logger.log('Health gate serving');
  }

  onApplicationShutdown(): void {
    this.gate.drain();
    this.logger.log('Health gate draining');
  }
}

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_GATE,
      useFactory: (
        config: RuntimeConfig,
        database: Database | undefined,
        broker: Broker | undefined,
      ) =>
        new Gate(
          Math.min(
            5000,
            Math.max(
              1000,
              config.database?.timeoutMs ?? config.nats?.timeoutMs ?? 1000,
            ),
          ),
          checksFor(config, database, broker),
        ),
      inject: [RUNTIME_CONFIG, DATABASE, NATS_BROKER],
    },
    HealthLifecycle,
  ],
})
export class PlatformHealthModule {}
