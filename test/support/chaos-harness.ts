import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import {
  ChaosEventBus,
  ChaosModule,
  FaultInjector,
} from '../../src/platform/chaos/index.js';
import { EVENT_BUS } from '../../src/platform/events/event-bus.js';
import { InMemoryEventBus } from '../../src/platform/events/in-memory-event-bus.js';

export type ChaosApplication = Readonly<{
  app: INestApplication;
  faults: FaultInjector;
}>;

/** Create the real Nest application with only the event transport wrapped. */
export async function createChaosApplication(): Promise<ChaosApplication> {
  const faults = new FaultInjector();
  const module = await Test.createTestingModule({
    imports: [AppModule, ChaosModule.forRoot(faults)],
  })
    .overrideProvider(EVENT_BUS)
    .useFactory({
      inject: [InMemoryEventBus],
      factory: (delegate: InMemoryEventBus) =>
        new ChaosEventBus(delegate, faults),
    })
    .compile();

  const app = module.createNestApplication();
  await app.init();

  return { app, faults };
}
