import { randomUUID } from 'node:crypto';

import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '@naakwu/flowkit-auth';

import { OrganizationContextGuard } from './auth/auth.module';
import { FlowkitDemoConsumer } from './flow/flowkit-demo.consumer';
import { asFlowkitHttpException } from './flowkit-http.errors';
import type { OrganizationContext } from './auth/organization-context';

type SessionRequest = { principal: AuthenticatedPrincipal; organizationContext: OrganizationContext };

@Controller('tasks')
@UseGuards(OrganizationContextGuard)
export class TasksController {
  constructor(private readonly consumer: FlowkitDemoConsumer) {}

  @Get()
  async list(@Req() req: SessionRequest) {
    try {
      return (await this.consumer.tasks(req.organizationContext).list({ actor: { id: req.principal.subjectId, roles: [req.principal.role] } })).items;
    } catch (error) {
      throw asFlowkitHttpException(error);
    }
  }

  @Post(':id/claim')
  async claim(@Param('id') id: string, @Body() body: { expectedRevision?: unknown } | undefined, @Req() req: SessionRequest) {
    const expectedRevision = body?.expectedRevision;
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new BadRequestException('expectedRevision must be a non-negative integer.');
    }
    const task = await this.consumer.repository.tasks.get(req.organizationContext, id);
    if (!task) throw new NotFoundException('Task not found.');
    await this.requireAssignedManager(task, req.principal, req.organizationContext);
    try {
      return await this.consumer.tasks(req.organizationContext).claim({
        taskId: task.id,
        expectedRevision,
        actor: { id: req.principal.subjectId, roles: [req.principal.role] },
        operationId: `claim:${task.id}:${req.principal.subjectId}:${randomUUID()}`,
      });
    } catch (error) {
      throw asFlowkitHttpException(error);
    }
  }

  private async requireAssignedManager(
    task: { subjectType: string; subjectId: string; role: string },
    current: AuthenticatedPrincipal,
    scope: OrganizationContext,
  ) {
    if (current.role !== 'manager' || current.readOnly || task.subjectType !== 'leave' || task.role !== 'manager') {
      throw new NotFoundException('Task not found.');
    }
    const request = await this.consumer.repository.getRequest(scope, task.subjectId);
    if (!request || request.manager_id !== current.subjectId) {
      throw new NotFoundException('Task not found.');
    }
  }
}
