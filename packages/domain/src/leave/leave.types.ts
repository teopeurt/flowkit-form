import { z } from 'zod';

export const leaveRequestSchema = z.object({
  employeeId: z.string().min(1),
  managerId: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  businessDays: z.number().int().positive(),
  reason: z.string().trim().min(3),
  balanceDays: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  if (value.endDate < value.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'endDate must not precede startDate' });
});

export type LeaveRequest = z.infer<typeof leaveRequestSchema>;
