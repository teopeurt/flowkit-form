import { z } from 'zod';

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().trim().min(1),
}).strict();

export const rideRequestSchema = z.object({
  riderId: z.string().min(1),
  /** Set once dispatch offers the trip; re-written on every re-dispatch. */
  driverId: z.string().min(1).nullable().default(null),
  pickup: coordinateSchema,
  dropoff: coordinateSchema,
  productTier: z.enum(['standard', 'xl', 'black']),
  paymentMethodId: z.string().min(1),
  /** Quoted up front, in minor units, so the rider sees a fixed price. */
  quotedFareCents: z.number().int().nonnegative(),
  estimatedDistanceMeters: z.number().int().positive(),
  estimatedDurationSeconds: z.number().int().positive(),
  surgeMultiplier: z.number().min(1).max(5).default(1),
  riderRating: z.number().min(1).max(5).nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  if (value.pickup.lat === value.dropoff.lat && value.pickup.lng === value.dropoff.lng) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dropoff'], message: 'dropoff must differ from pickup' });
  }
});

export type RideRequest = z.infer<typeof rideRequestSchema>;
