import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BusinessClosureInputSchema, WeeklyScheduleSchema } from "@agendia/domain";
import { ResourceCatalogError } from "@agendia/db";
import type { RouteFailure, TenantRouteContext } from "./context.ts";

export function registerBusinessClosureRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite, closureFailure, closureMissing }: TenantRouteContext & {
    closureFailure: RouteFailure;
    closureMissing: Error;
  },
) {
  app.get("/me/business-calendar/closures", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    try {
      return await pools.api.run(context(auth, request), repo => repo.listBusinessClosures(auth.business_id!));
    } catch (error) { return closureFailure(error, request, reply); }
  });
  app.post("/me/business-calendar/closures", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = BusinessClosureInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid closure fields");
    try {
      const saved = await tenantWrite(auth, request, "business_closure.created", async repo => {
        // Repository owns the early lock and future-Confirmed closure guard.
        return repo.createBusinessClosure(auth.business_id!, parsed.data);
      });
      return reply.code(201).send(saved);
    } catch (error) { return closureFailure(error, request, reply); }
  });
  app.put("/me/business-calendar/closures/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = BusinessClosureInputSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid closure fields");
    try {
      return await tenantWrite(auth, request, "business_closure.updated", async repo => {
        const saved = await repo.updateBusinessClosure(auth.business_id!, params.data.id, parsed.data);
        if (!saved) throw closureMissing;
        return saved;
      });
    } catch (error) { return closureFailure(error, request, reply); }
  });
  app.delete("/me/business-calendar/closures/:id", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid closure ID");
    try {
      await tenantWrite(auth, request, "business_closure.deleted", async repo => {
        if (!await repo.deleteBusinessClosure(auth.business_id!, params.data.id)) throw closureMissing;
      });
      return reply.code(204).send();
    } catch (error) { return closureFailure(error, request, reply); }
  });
}

export function registerBusinessCalendarRoutes(
  app: FastifyInstance,
  { pools, requireTenant, context, fail, tenantWrite, closureFailure, resourceFailure }: TenantRouteContext & {
    closureFailure: RouteFailure;
    resourceFailure: RouteFailure;
  },
) {
  const calendarBody = z.object({ weeklySchedule: WeeklyScheduleSchema });
  app.get("/me/business-calendar", async (request, reply) => {
    const auth = await requireTenant(request, reply);
    if (!auth) return;
    try {
      return await pools.api.run(context(auth, request), repo => repo.getBusinessCalendar(auth.business_id!));
    } catch {
      return fail(reply, request, 500, "INTERNAL_ERROR", "Calendar operation failed");
    }
  });
  app.put("/me/business-calendar", async (request, reply) => {
    const auth = await requireTenant(request, reply, true);
    if (!auth) return;
    const parsed = calendarBody.safeParse(request.body);
    if (!parsed.success)
      return fail(reply, request, 400, "VALIDATION_FAILED", "Invalid weekly schedule");
    try {
      return await tenantWrite(auth, request, "business_calendar.updated", async repo => {
        await repo.acquireBusinessCalendarLock(context(auth, request));
        // Repository guards configured resource hours and future Confirmed intervals.
        return repo.saveBusinessCalendar(auth.business_id!, parsed.data.weeklySchedule);
      });
    } catch (error) {
      if (error instanceof ResourceCatalogError && error.code === "FUTURE_APPOINTMENT_CONFLICT")
        return closureFailure(error, request, reply);
      if (error instanceof ResourceCatalogError) return resourceFailure(error, request, reply);
      return fail(reply, request, 500, "INTERNAL_ERROR", "Calendar operation failed");
    }
  });
}
