import { Controller, Get, Inject } from '@nestjs/common';

import { liveHealth, readyHealth, type ReadinessProbe } from './health.responses';

export const READINESS_PROBE = Symbol('READINESS_PROBE');

@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_PROBE) private readonly readiness: ReadinessProbe) {}

  @Get('live')
  live() { return liveHealth(); }

  @Get('ready')
  async ready() {
    return readyHealth(this.readiness);
  }
}
