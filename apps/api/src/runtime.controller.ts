import { Controller, Get, UseGuards } from '@nestjs/common';

import { OrganizationContextGuard } from './auth/auth.module';
import { loadConfig } from '@flowkit-demo/domain';
import { RuntimeHealthRepository } from '@flowkit-demo/database';

@Controller('runtime')
@UseGuards(OrganizationContextGuard)
export class RuntimeController {
  constructor(private readonly health: RuntimeHealthRepository) {}

  @Get()
  async status() {
    const [flowkitRuntime, delivery] = await Promise.all([
      this.health.health('flowkit-runtime'),
      this.health.health('delivery-worker'),
    ]);
    return {
      mailpitUrl: loadConfig().MAILPIT_URL,
      flowkitRuntime: {
        ready: flowkitRuntime.ready,
        heartbeatAt: flowkitRuntime.heartbeatAt,
        checkedAt: flowkitRuntime.checkedAt,
      },
      delivery: {
        ready: delivery.ready,
        heartbeatAt: delivery.heartbeatAt,
        checkedAt: delivery.checkedAt,
      },
    };
  }
}
