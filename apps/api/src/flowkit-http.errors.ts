import {
  AuthorizationRejectionError,
  GuardRejectionError,
  InvalidTransitionError,
} from '@naakwu/flowkit-core';
import { FlowkitTaskError } from '@naakwu/flowkit-tasks';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

import { LeaveFlowProjectionConflictError } from '@flowkit-demo/database';

export function asFlowkitHttpException(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof LeaveFlowProjectionConflictError) return new ConflictException(error.message);
  if (error instanceof AuthorizationRejectionError || error instanceof GuardRejectionError) return new ForbiddenException(error.message);
  if (error instanceof InvalidTransitionError) return new BadRequestException(error.message);
  if (error instanceof FlowkitTaskError) {
    if (error.code === 'task_not_found') return new NotFoundException(error.message);
    if (error.code === 'task_claim_conflict' || error.code === 'stale_task_revision') return new ConflictException(error.message);
    return new ForbiddenException(error.message);
  }
  const message = error instanceof Error ? error.message : '';
  if (/not_found|actor_not_found/.test(message)) return new NotFoundException('The requested Flowkit resource was not found.');
  if (/stale|conflict/.test(message)) return new ConflictException(message);
  if (/not_authorized|not_owned|role_ineligible|employee_not_authorized/.test(message)) return new ForbiddenException(message);
  if (/invalid_action|action is required/.test(message)) return new BadRequestException(message);
  return error;
}
