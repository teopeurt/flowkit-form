import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '@naakwu/flowkit-auth';

import { OrganizationContextGuard } from './auth/auth.module';
import { FlowkitDemoConsumer } from './flow/flowkit-demo.consumer';
import type { OrganizationContext } from './auth/organization-context';

@Controller('notifications')
@UseGuards(OrganizationContextGuard)
export class NotificationsController {
  constructor(private readonly consumer: FlowkitDemoConsumer) {}

  @Get()
  async list(@Req() req: { principal: AuthenticatedPrincipal; organizationContext: OrganizationContext }) {
    const userId = req.principal.subjectId;
    const [inbox, deliveries] = await Promise.all([
      this.consumer.inbox.forUser(req.organizationContext, userId),
      this.consumer.outbox.listForRecipient(req.organizationContext, userId),
    ]);
    return { inbox, deliveries };
  }
}
