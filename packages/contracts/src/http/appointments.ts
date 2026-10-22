import { z } from "zod";
import { ClientInputSchema } from "@agendia/domain/client-registry";
import { CalendarDateSchema, InstantSchema, parseInstantMs } from "@agendia/domain/calendar-values";
import { AppointmentTermsSnapshotSchema, AppointmentStateSchema, AppointmentOriginSchema } from "@agendia/domain/appointment-lifecycle";

const appointmentId = z.string().uuid();
export const AppointmentListQuerySchema = z.object({
  clientId: appointmentId.optional(), from: InstantSchema.optional(), to: InstantSchema.optional(),
}).strict().refine(value => value.from === undefined || value.to === undefined || parseInstantMs(value.from)! < parseInstantMs(value.to)!);
/** Current client identity and historical terms, matching the DAL read projection. */
export const AppointmentRecordSchema = z.object({
  id: appointmentId,
  client: z.object({ id: appointmentId, firstName: z.string(), lastName: z.string(), phone: z.string() }).strict(),
  startsAt: InstantSchema,
  startMs: z.number().int(), endMs: z.number().int(),
  terms: z.object({ serviceId: appointmentId, serviceName: z.string(), resourceId: appointmentId,
    resourceName: z.string(), durationMinutes: z.number().int().positive(), priceArs: z.number().finite().nonnegative() }).strict(),
  state: AppointmentStateSchema, origin: AppointmentOriginSchema,
  notes: z.string().nullable(), customerResourcePreference: appointmentId.nullable(),
}).strict();
export type AppointmentRecord = z.infer<typeof AppointmentRecordSchema>;
const availabilityId = appointmentId.transform(id => id.toLowerCase());
export const AppointmentAvailabilityQuerySchema = z.object({
  serviceId: availabilityId, date: CalendarDateSchema,
  resourceId: availabilityId.optional(), appointmentId: availabilityId.optional(),
}).strict();
/** Exact D2 advisory projection; saves must revalidate, not reserve these offers. */
export const AvailabilitySlotSchema = z.object({
  start: InstantSchema, startMs: z.number().int().safe(), endMs: z.number().int().safe(),
  resourceId: availabilityId, terms: AppointmentTermsSnapshotSchema.unwrap().strict(),
}).strict();
/** Structural edits cannot change client, notes, state, origin or customer preference. */
export const ManualAppointmentChangeSchema = z.object({
  serviceId: availabilityId, resourceId: availabilityId, startRaw: InstantSchema, date: CalendarDateSchema,
  expectedTerms: AvailabilitySlotSchema.shape.terms.extend({ serviceId: availabilityId, resourceId: availabilityId })
    .refine(terms => !terms.serviceName.includes("\0") && !terms.resourceName.includes("\0")),
  confirmed: z.literal(true),
}).strict();
export type ManualAppointmentChangeRequest = z.infer<typeof ManualAppointmentChangeSchema>;
export type ManualAppointmentChangeResponse = AppointmentRecord;
/** Match DAL note validation: null clears; empty string remains a string; no arbitrary length limit. */
export const ManualAppointmentNotesSchema = z.object({
  notes: z.string().refine(notes => !notes.includes("\0")).nullable(),
}).strict();
/** Manual action authority is server-owned, independent of the stored booking origin. */
export const ManualAppointmentStateSchema = z.object({
  state: AppointmentStateSchema.exclude(["confirmed"]), confirmed: z.literal(true),
}).strict();
export type ManualAppointmentNotesRequest = z.infer<typeof ManualAppointmentNotesSchema>;
export type ManualAppointmentNotesResponse = AppointmentRecord;
export type ManualAppointmentStateRequest = z.infer<typeof ManualAppointmentStateSchema>;
export type ManualAppointmentStateResponse = AppointmentRecord;
/** Optimistic offered terms are a precondition, never persistence authority or sender proof. */
export const ManualAppointmentCreateSchema = z.object({
  serviceId: availabilityId, resourceId: availabilityId, startRaw: InstantSchema, date: CalendarDateSchema,
  expectedTerms: AvailabilitySlotSchema.shape.terms.extend({ serviceId: availabilityId, resourceId: availabilityId })
    .refine(terms => !terms.serviceName.includes("\0") && !terms.resourceName.includes("\0")),
  confirmed: z.literal(true), clientId: availabilityId.optional(),
  newClient: ClientInputSchema.strict().refine(client => !client.firstName.includes("\0") && !client.lastName.includes("\0")).optional(),
  notes: z.string().refine(notes => !notes.includes("\0")).optional(),
}).strict().refine(value => (value.clientId !== undefined) !== (value.newClient !== undefined), { message: "Exactly one client source is required" });
export type ManualAppointmentCreateRequest = z.infer<typeof ManualAppointmentCreateSchema>;
export type ManualAppointmentCreateResponse = AppointmentRecord;
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;
export const AppointmentOperationKeySchema = z.string().uuid().transform(value => value.toLowerCase());
export const AppointmentOperationContextSchema = z.object({
  key: AppointmentOperationKeySchema,
  kind: z.enum(["create", "change", "notes", "state"]), target: appointmentId.nullable(),
}).strict().refine(value => (value.kind === "create") === (value.target === null));
export type AppointmentOperationContext = z.infer<typeof AppointmentOperationContextSchema>;
export const AppointmentOperationReceiptSchema = z.object({
  key: AppointmentOperationKeySchema, businessId: appointmentId, identityId: appointmentId,
  state: z.enum(["not_found", "pending", "completed", "failed", "cancelled"]),
  kind: z.enum(["create", "change", "notes", "state"]).nullable(), target: appointmentId.nullable(),
  httpStatus: z.number().int().nullable(), appointment: AppointmentRecordSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
}).strict();
export type AppointmentOperationReceipt = z.infer<typeof AppointmentOperationReceiptSchema>;
export type AppointmentAvailabilityQuery = z.infer<typeof AppointmentAvailabilityQuerySchema>;
