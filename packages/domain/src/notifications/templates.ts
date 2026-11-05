import { z } from 'zod';
import { createTemplateRegistry, template } from '@naakwu/flowkit-notify';

const leaveData = z.object({ requestId: z.string(), stage: z.string(), employeeName: z.string() }).strict();
export const notificationTemplates = createTemplateRegistry([
  template('leave.accepted', leaveData, data => ({ subject: `Leave ${data.requestId} approved`, body: `${data.employeeName}, your leave request was approved.`, severity: 'success' })),
  template('leave.rejected', leaveData, data => ({ subject: `Leave ${data.requestId} rejected`, body: `${data.employeeName}, your leave request was rejected.`, severity: 'error' })),
  template('leave.manager_review', leaveData, data => ({ subject: `Leave ${data.requestId} needs review`, body: `A leave request is waiting for manager review.`, severity: 'info' })),
  template('leave.overdue', leaveData, data => ({ subject: `Leave ${data.requestId} is overdue`, body: `Manager review is past its demo SLA.`, severity: 'warning' })),
]);
