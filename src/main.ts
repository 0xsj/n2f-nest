import { Logger } from '@nestjs/common';
import { createHttpApplication } from './app/http-application.js';
import { closeOnSignals } from './app/shutdown.js';
import { HEALTH_GATE } from './platform/health/index.js';
import { runtimeConfigOrThrow } from './platform/runtime/index.js';
import type { Gate } from './shared/health/index.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  logger.log('Starting n2f-nest backend');
  const config = runtimeConfigOrThrow();
  const app = await createHttpApplication(config);
  if (config.http.devEndpoints) {
    logger.warn('N2F_DEV_ENDPOINTS is enabled; do not use this setting in production');
  }
  closeOnSignals(app, app.get<Gate>(HEALTH_GATE), config.shutdownDrainMs, (error) =>
    logger.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
