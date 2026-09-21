import { Module } from '@nestjs/common';
import { EVENT_BUS } from './event-bus.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';

const eventBusProvider = {
  provide: EVENT_BUS,
  useExisting: InMemoryEventBus,
};

@Module({
  providers: [InMemoryEventBus, eventBusProvider],
  exports: [InMemoryEventBus, EVENT_BUS],
})
export class PlatformEventsModule {}
