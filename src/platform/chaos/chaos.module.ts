import { Module, type DynamicModule } from '@nestjs/common';
import { FaultInjector } from './fault-injector.js';

/**
 * Opt-in Nest support for resilience tests. AppModule does not import this
 * module; integration harnesses add it explicitly when they want faults.
 */
@Module({})
export class ChaosModule {
  static forRoot(faults = new FaultInjector()): DynamicModule {
    return {
      module: ChaosModule,
      providers: [{ provide: FaultInjector, useValue: faults }],
      exports: [FaultInjector],
    };
  }
}
