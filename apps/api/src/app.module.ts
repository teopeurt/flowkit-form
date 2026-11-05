import { Module } from '@nestjs/common';

import { createDemoDatabaseClient } from '@flowkit-demo/database';
import { RuntimeHealthRepository } from '@flowkit-demo/database';
import { FlowkitDemoConsumer } from './flow/flowkit-demo.consumer';
import { AuthModule } from './auth/auth.module';
import { FlowController } from './flow.controller';
import { HealthController, READINESS_PROBE } from './health.controller';
import { type ReadinessProbe } from './health.responses';
import { NotificationsController } from './notifications.controller';
import { RuntimeController } from './runtime.controller';
import { TasksController } from './tasks.controller';

const readinessProbeProvider = {
  provide: READINESS_PROBE,
  useFactory: (): ReadinessProbe => {
    const client = createDemoDatabaseClient();
    return { ping: async () => { await client`select 1`; } };
  },
};

@Module({
  imports: [AuthModule],
  controllers: [HealthController, FlowController, TasksController, NotificationsController, RuntimeController],
  providers: [FlowkitDemoConsumer, RuntimeHealthRepository, readinessProbeProvider],
})
export class AppModule {}
