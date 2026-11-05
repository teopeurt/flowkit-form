import { z } from 'zod';

/**
 * A Nigerian National Identification Number: exactly eleven digits.
 *
 * Held as a string, never a number. Leading zeros are significant and a NIN is an identifier
 * rather than a quantity — arithmetic on one is always a bug.
 */
const ninSchema = z.string().regex(/^\d{11}$/, 'NIN must be exactly 11 digits');

const consentGrantSchema = z.object({
  /** The version of the notice the worker actually saw, not the current one. */
  noticeVersion: z.string().trim().min(1),
  grantedAt: z.string().datetime(),
  /** Onboarding Workflows §1.1 step 2: the language the explainer was delivered in. */
  language: z.enum(['en', 'ha', 'ig', 'yo', 'pcm']),
  /** True when an agent walked the worker through the notice in person. */
  explainedInPerson: z.boolean(),
}).strict();

export const enrolmentRequestSchema = z.object({
  workerId: z.string().min(1),
  /** Null on the self-serve path. Fixed for the life of the flow once set. */
  agentId: z.string().min(1).nullable().default(null),
  channel: z.enum(['agent_assisted', 'self_serve']),
  nin: ninSchema,
  phone: z.string().regex(/^\+234\d{10}$/, 'phone must be E.164 Nigerian'),
  categories: z.array(z.string().trim().min(1)).min(1).max(3),
  cluster: z.string().trim().min(1),
  consent: consentGrantSchema,
  /**
   * Reference to the sealed evidence bundle, not the biometric itself. Raw biometrics never enter
   * the flow subject: they live in encrypted object storage and the flow carries a hash.
   */
  evidenceBundleHash: z.string().regex(/^[a-f0-9]{64}$/, 'evidence hash must be sha256 hex').nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  if (value.channel === 'agent_assisted' && value.agentId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agentId'], message: 'agent_assisted enrolment requires an agentId' });
  }
  if (value.channel === 'self_serve' && value.agentId !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agentId'], message: 'self_serve enrolment must not carry an agentId' });
  }
  if (value.channel === 'self_serve' && value.consent.explainedInPerson) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consent', 'explainedInPerson'], message: 'self_serve consent cannot have been explained in person' });
  }
});

export type EnrolmentRequest = z.infer<typeof enrolmentRequestSchema>;
