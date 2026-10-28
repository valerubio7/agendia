import type {
  AppointmentRecord, AppointmentAvailabilityQuery, AvailabilitySlot,
  ManualAppointmentCreateRequest, ManualAppointmentChangeRequest,
  ManualAppointmentNotesRequest, ManualAppointmentStateRequest, PlatformAiInstructions,
  AppointmentOperationContext, AppointmentOperationReceipt,
} from "@agendia/contracts";
export type {
  AppointmentAvailabilityQuery, AvailabilitySlot, ManualAppointmentCreateRequest,
  ManualAppointmentChangeRequest, ManualAppointmentNotesRequest, ManualAppointmentStateRequest,
  AppointmentOperationContext, AppointmentOperationReceipt,
} from "@agendia/contracts";
export type { AppointmentRecord } from "@agendia/contracts";
export type Client = { id: string; firstName: string; lastName: string; phone: string };
export type ClientInput = Pick<Client, "firstName" | "lastName" | "phone">;
export type { PlatformAiInstructions } from "@agendia/contracts";

export type Session = {
  identityId: string;
  role: "platform_admin" | "business_user";
  businessId: string | null;
};
export type Business = {
  id: string;
  name: string;
  status: "active" | "suspended";
  agentStatus: "active" | "inactive";
  whatsappStatus: "connected" | "disconnected" | "link_required" | "error";
  createdAt: string;
  lastTechnicalActivityAt: string | null;
};
export type Profile = {
  displayName: string;
  description: string;
  address: string;
};
export type Service = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceArs: number;
  status: "active" | "suspended";
};
export type Resource = {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "suspended";
  serviceIds: string[];
  weeklySchedule: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, { startMinute: number; endMinute: number }[]>>;
};
export type WeeklySchedule = Resource["weeklySchedule"];
export type BusinessCalendar = { weeklySchedule: WeeklySchedule | null };
export type BusinessClosureRequest =
  | { kind: "date"; date: string; start?: never; end?: never }
  | { kind: "interval"; start: string; end: string; date?: never };
export type BusinessClosure = { id: string } & BusinessClosureRequest;
export type ResourceInput = {
  name: string;
  description?: string;
  serviceIds: string[];
  weeklySchedule: Resource["weeklySchedule"];
};
export type ServiceInput = {
  name: string;
  description?: string;
  durationMinutes: number;
  priceArs: number;
};
export type Agent = {
  style: string;
  businessInstructions: string;
  active: boolean;
  revision: number;
};
export type WhatsAppStatus = {
  status: "connected" | "disconnected" | "link_required" | "linking" | "reconnecting" | "error";
  linkedNumber?: string | null;
  linkedAt?: string | null;
  lastConnectedAt?: string | null;
};
export type ApiTransport = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
export type WhatsAppQrWaitOptions = {
  attempts?: number;
  intervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
};

const API_BASE = "/api";
const VALIDATION_ORIGIN = "https://agendia.invalid";
const DOT_SEGMENT = /(?:^|[\\/])(?:(?:\.|%2e){1,2})(?=[\\/?#]|$)/i;
const MALFORMED_PERCENT_ESCAPE = /%(?![\da-f]{2})/i;

function assertSafeUrlText(value: string, label: string): void {
  if (
    !value ||
    value.trim() !== value ||
    value.includes("\\") ||
    DOT_SEGMENT.test(value) ||
    MALFORMED_PERCENT_ESCAPE.test(value)
  )
    throw new TypeError(`Invalid ${label}`);
}

function composeApiPath(base: string, path: string): string {
  assertSafeUrlText(base, "API base");
  assertSafeUrlText(path, "API path");
  if (base !== API_BASE || !path.startsWith("/") || path.startsWith("//"))
    throw new TypeError("Invalid API base or path");
  const input = `${base}${path}`;
  let destination: URL;
  try {
    destination = new URL(input, VALIDATION_ORIGIN);
  } catch {
    throw new TypeError("Invalid API URL");
  }
  if (
    destination.origin !== VALIDATION_ORIGIN ||
    !destination.pathname.startsWith(`${API_BASE}/`) ||
    destination.pathname !== input ||
    destination.search ||
    destination.hash
  )
    throw new TypeError("Invalid API URL");
  return input;
}

export function createBrowserApiTransport(
  origin: string,
  fetchTransport?: ApiTransport,
): ApiTransport {
  let currentOrigin: URL;
  try {
    currentOrigin = new URL(origin);
  } catch {
    throw new TypeError("Invalid browser origin");
  }
  if (
    !["http:", "https:"].includes(currentOrigin.protocol) ||
    currentOrigin.origin !== origin ||
    currentOrigin.pathname !== "/" ||
    currentOrigin.search ||
    currentOrigin.hash ||
    currentOrigin.username ||
    currentOrigin.password
  )
    throw new TypeError("Invalid browser origin");

  return async (input, init) => {
    assertSafeUrlText(input, "API request URL");
    if (input.startsWith("//")) throw new TypeError("Invalid API request URL");
    let destination: URL;
    try {
      destination = new URL(input, currentOrigin.origin);
    } catch {
      throw new TypeError("Invalid API request URL");
    }
    if (
      destination.origin !== currentOrigin.origin ||
      !destination.pathname.startsWith(`${API_BASE}/`) ||
      destination.hash ||
      destination.username ||
      destination.password
    )
      throw new TypeError("Invalid API request URL");
    const requestTarget = `${destination.pathname}${destination.search}`;
    return fetchTransport
      ? fetchTransport(requestTarget, init)
      : globalThis.fetch(requestTarget, init);
  };
}

const defaultBrowserTransport: ApiTransport = (input, init) => {
  if (typeof location === "undefined")
    return Promise.reject(new TypeError("Browser origin is unavailable"));
  return createBrowserApiTransport(location.origin)(input, init);
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const safeMessages: Record<string, string> = {
  UNAUTHENTICATED:
    "Tu sesión expiró o el negocio está suspendido. Iniciá sesión nuevamente.",
  FORBIDDEN: "Tu rol o el estado del negocio no permite esta acción.",
  VALIDATION_FAILED: "Revisá los campos indicados.",
  CONFLICT: "Los datos cambiaron. Recargá y volvé a intentar.",
  WHATSAPP_ASSISTANT_INACTIVE: "Activá el asistente antes de vincular WhatsApp.",
  NOT_FOUND: "El recurso no está disponible.",
};

export function formValues(form: FormData, allow: readonly string[]) {
  return Object.fromEntries(
    allow.map((key) => [
      key,
      key === "active" ? form.has(key) : String(form.get(key) ?? ""),
    ]),
  );
}

export class ApiClient {
  private csrf = "";
  private operation: { key: string; capture: (operation: AppointmentOperationContext) => void } | null = null;
  withAppointmentOperation<T>(key: string, capture: (operation: AppointmentOperationContext) => void, work: () => Promise<T>): Promise<T> {
    if (this.operation) throw new Error("An operation is already being dispatched");
    this.operation = { key, capture };
    try { return work(); } finally { this.operation = null; }
  }
  private appointmentCall(path: string, method: string, body: unknown, signal: AbortSignal | undefined,
    kind: AppointmentOperationContext["kind"], target: string | null) {
    const operation = this.operation;
    operation?.capture({ key: operation.key, kind, target });
    return this.call<AppointmentRecord>(path, method, body, undefined, signal, undefined, operation?.key);
  }
  appointmentOperation = (key: string, signal?: AbortSignal) =>
    this.call<AppointmentOperationReceipt>(`/me/appointment-operations/${encodeURIComponent(key)}`, "GET", undefined, "no-store", signal);
  cancelAppointmentOperation = (operation: AppointmentOperationContext, signal?: AbortSignal) =>
    this.call<AppointmentOperationReceipt>(`/me/appointment-operations/${encodeURIComponent(operation.key)}/cancel`, "POST",
      { key: operation.key, kind: operation.kind, target: operation.target }, undefined, signal);
  constructor(
    private readonly transport: ApiTransport = defaultBrowserTransport,
    private readonly base = API_BASE,
  ) {}
  private async call<T>(
    path: string,
    method = "GET",
    body?: unknown,
    cache?: RequestCache,
    signal?: AbortSignal,
    query?: URLSearchParams,
    operationKey?: string,
  ): Promise<T> {
    // Validate the path unchanged; only separately encoded parameters may add a query.
    const safePath = composeApiPath(this.base, path);
    const requestPath = query?.size ? `${safePath}?${query.toString()}` : safePath;
    const csrf =
      this.csrf ||
      (typeof sessionStorage === "undefined"
        ? ""
        : (sessionStorage.getItem("agendia.csrf") ?? ""));
    const response = await this.transport(requestPath, {
      method,
      credentials: "include",
      ...(cache ? { cache } : {}),
      ...(signal ? { signal } : {}),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(operationKey === undefined ? {} : { "x-appointment-operation-key": operationKey }),
        ...(method === "GET" || !csrf ? {} : { "x-csrf-token": csrf }),
        ...(path === "/auth/csrf" ? { "x-csrf-bootstrap": "1" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data =
      response.status === 204
        ? undefined
        : ((await response.json().catch(() => undefined)) as
            | { code?: string; message?: string }
            | undefined);
    if (!response.ok) {
      if (response.status === 401) this.setCsrf("");
      throw new ApiError(
        data?.code ?? "INTERNAL_ERROR",
        data?.message ?? "Request failed",
        response.status,
      );
    }
    return data as T;
  }
  private setCsrf(value: string) {
    this.csrf = value;
    if (typeof sessionStorage === "undefined") return;
    if (value) sessionStorage.setItem("agendia.csrf", value);
    else sessionStorage.removeItem("agendia.csrf");
  }
  async login(email: string, password: string) {
    const { csrfToken } = await this.call<{ csrfToken: string }>(
      "/auth/login",
      "POST",
      { email, password },
    );
    this.setCsrf(csrfToken);
    return this.session();
  }
  session = async () => {
    const session = await this.call<Session>("/auth/session", "GET", undefined, "no-store");
    const stored = this.csrf || (typeof sessionStorage === "undefined" ? "" : sessionStorage.getItem("agendia.csrf"));
    if (!stored) {
      const { csrfToken } = await this.call<{ csrfToken: string }>("/auth/csrf", "POST", undefined, "no-store");
      this.setCsrf(csrfToken);
    }
    return session;
  };
  async logout() {
    await this.call("/auth/logout", "POST");
    this.setCsrf("");
  }
  platformAiInstructions = () => this.call<PlatformAiInstructions>("/admin/ai-instructions");
  savePlatformAiInstructions = (additionalInstructions: string, replyPacing?: PlatformAiInstructions["replyPacing"]) =>
    this.call<PlatformAiInstructions>("/admin/ai-instructions", "PUT", { additionalInstructions, replyPacing });
  businesses = () => this.call<Business[]>("/admin/businesses");
  createBusiness = (body: {
    name: string;
    userEmail: string;
    initialPassword: string;
  }) => this.call<Business>("/admin/businesses", "POST", body);
  renameBusiness = (id: string, name: string) =>
    this.call<Business>(`/admin/businesses/${encodeURIComponent(id)}`, "PUT", {
      name,
    });
  setBusinessStatus = (id: string, status: "active" | "suspended") =>
    this.call<Business>(
      `/admin/businesses/${encodeURIComponent(id)}/status`,
      "PUT",
      { status },
    );
  replacePassword = (id: string, password: string) =>
    this.call(`/admin/businesses/${encodeURIComponent(id)}/user`, "PUT", {
      password,
    });
  clients = (q = "", signal?: AbortSignal) =>
    this.call<Client[]>("/me/clients", "GET", undefined, undefined, signal,
      q.trim() ? new URLSearchParams({ q: q.trim() }) : undefined);
  createClient = (body: ClientInput, signal?: AbortSignal) =>
    this.call<Client>("/me/clients", "POST",
      { firstName: body.firstName, lastName: body.lastName, phone: body.phone }, undefined, signal);
  updateClient = (id: string, body: ClientInput, signal?: AbortSignal) =>
    this.call<Client>(`/me/clients/${encodeURIComponent(id)}`, "PUT",
      { firstName: body.firstName, lastName: body.lastName, phone: body.phone }, undefined, signal);
  clientAppointments = (clientId: string, signal?: AbortSignal) =>
    this.call<AppointmentRecord[]>("/me/appointments", "GET", undefined, undefined, signal,
      new URLSearchParams({ clientId }));
  appointments = (filters: { from?: string; to?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (filters.from !== undefined) query.set("from", filters.from);
    if (filters.to !== undefined) query.set("to", filters.to);
    return this.call<AppointmentRecord[]>("/me/appointments", "GET", undefined, undefined, signal, query);
  };
  appointment = (id: string, signal?: AbortSignal) =>
    this.call<AppointmentRecord>(`/me/appointments/${encodeURIComponent(id)}`, "GET", undefined, undefined, signal);
  appointmentAvailability = (input: AppointmentAvailabilityQuery, signal?: AbortSignal) => {
    const query = new URLSearchParams({ serviceId: input.serviceId, date: input.date });
    if (input.resourceId !== undefined) query.set("resourceId", input.resourceId);
    if (input.appointmentId !== undefined) query.set("appointmentId", input.appointmentId);
    return this.call<AvailabilitySlot[]>("/me/appointments/availability", "GET", undefined, undefined, signal, query);
  };
  private appointmentStructure(body: ManualAppointmentChangeRequest) {
    const terms = body.expectedTerms;
    return {
      serviceId: body.serviceId, resourceId: body.resourceId, startRaw: body.startRaw, date: body.date,
      confirmed: body.confirmed,
      expectedTerms: {
        serviceId: terms.serviceId, serviceName: terms.serviceName, resourceId: terms.resourceId,
        resourceName: terms.resourceName, durationMinutes: terms.durationMinutes, priceArs: terms.priceArs,
      },
    };
  }
  createAppointment = (body: ManualAppointmentCreateRequest, signal?: AbortSignal) =>
    this.appointmentCall("/me/appointments", "POST", {
      ...this.appointmentStructure(body),
      ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
      ...(body.newClient === undefined ? {} : { newClient: {
        firstName: body.newClient.firstName, lastName: body.newClient.lastName, phone: body.newClient.phone,
      } }),
      ...(body.notes === undefined ? {} : { notes: body.notes }),
    }, signal, "create", null);
  changeAppointment = (id: string, body: ManualAppointmentChangeRequest, signal?: AbortSignal) =>
    this.appointmentCall(`/me/appointments/${encodeURIComponent(id)}`, "PATCH",
      this.appointmentStructure(body), signal, "change", id);
  appointmentNotes = (id: string, body: ManualAppointmentNotesRequest, signal?: AbortSignal) =>
    this.appointmentCall(`/me/appointments/${encodeURIComponent(id)}/notes`, "PATCH",
      { notes: body.notes }, signal, "notes", id);
  appointmentState = (id: string, body: ManualAppointmentStateRequest, signal?: AbortSignal) =>
    this.appointmentCall(`/me/appointments/${encodeURIComponent(id)}/state`, "PATCH",
      { state: body.state, confirmed: body.confirmed }, signal, "state", id);
  businessClosures = (signal?: AbortSignal) =>
    this.call<BusinessClosure[]>("/me/business-calendar/closures", "GET", undefined, undefined, signal);
  createBusinessClosure = (body: BusinessClosureRequest, signal?: AbortSignal) =>
    this.call<BusinessClosure>("/me/business-calendar/closures", "POST", body, undefined, signal);
  updateBusinessClosure = (id: string, body: BusinessClosureRequest, signal?: AbortSignal) =>
    this.call<BusinessClosure>(`/me/business-calendar/closures/${encodeURIComponent(id)}`, "PUT", body, undefined, signal);
  deleteBusinessClosure = (id: string, signal?: AbortSignal) =>
    this.call<void>(`/me/business-calendar/closures/${encodeURIComponent(id)}`, "DELETE", undefined, undefined, signal);
  businessCalendar = (signal?: AbortSignal) =>
    this.call<BusinessCalendar>("/me/business-calendar", "GET", undefined, undefined, signal);
  saveBusinessCalendar = (weeklySchedule: WeeklySchedule, signal?: AbortSignal) =>
    this.call<BusinessCalendar>("/me/business-calendar", "PUT", { weeklySchedule }, undefined, signal);
  resources = (signal?: AbortSignal) => this.call<Resource[]>("/me/resources", "GET", undefined, undefined, signal);
  createResource = (body: ResourceInput, signal?: AbortSignal) =>
    this.call<Resource>("/me/resources", "POST", body, undefined, signal);
  updateResource = (id: string, body: ResourceInput, signal?: AbortSignal) =>
    this.call<Resource>(`/me/resources/${encodeURIComponent(id)}`, "PUT", body, undefined, signal);
  setResourceStatus = (id: string, status: Resource["status"], signal?: AbortSignal) =>
    this.call<Resource>(`/me/resources/${encodeURIComponent(id)}/status`, "PUT", { status }, undefined, signal);
  retireResource = (id: string, signal?: AbortSignal) =>
    this.call<{ id: string }>(`/me/resources/${encodeURIComponent(id)}`, "DELETE", undefined, undefined, signal);
  services = (signal?: AbortSignal) => this.call<Service[]>("/me/services", "GET", undefined, undefined, signal);
  createService = (body: ServiceInput, signal?: AbortSignal) =>
    this.call<Service>("/me/services", "POST", body, undefined, signal);
  updateService = (id: string, body: ServiceInput, signal?: AbortSignal) =>
    this.call<Service>(`/me/services/${encodeURIComponent(id)}`, "PUT", body, undefined, signal);
  setServiceStatus = (id: string, status: Service["status"], signal?: AbortSignal) =>
    this.call<Service>(`/me/services/${encodeURIComponent(id)}/status`, "PUT", { status }, undefined, signal);
  retireService = (id: string, signal?: AbortSignal) =>
    this.call<{ id: string }>(`/me/services/${encodeURIComponent(id)}`, "DELETE", undefined, undefined, signal);
  profile = () => this.call<Partial<Profile>>("/me/business-profile");
  saveProfile = (body: Profile) =>
    this.call<Profile>("/me/business-profile", "PUT", {
      displayName: body.displayName,
      description: body.description,
      address: body.address,
    });
  agent = () => this.call<Partial<Agent>>("/me/agent");
  saveAgent = (
    body: Omit<Agent, "revision"> & { expectedRevision: number },
  ) => this.call<Agent>("/me/agent", "PUT", body);
  whatsappStatus = (signal?: AbortSignal) =>
    this.call<WhatsAppStatus>(
      "/me/whatsapp/status",
      "GET",
      undefined,
      undefined,
      signal,
    );
  requestWhatsAppLink = (signal?: AbortSignal) =>
    this.call<{ status: string }>(
      "/me/whatsapp/link",
      "POST",
      undefined,
      undefined,
      signal,
    );
  whatsappQr = (signal?: AbortSignal) =>
    this.call<{ qr: string }>(
      "/me/whatsapp/link",
      "GET",
      undefined,
      "no-store",
      signal,
    );
  async requestOrResumeWhatsAppLink(options: WhatsAppQrWaitOptions = {}) {
    try {
      await this.requestWhatsAppLink(options.signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "CONFLICT")
        throw error;
      if (error.message === "Activate the assistant before linking WhatsApp")
        throw new ApiError("WHATSAPP_ASSISTANT_INACTIVE", "Assistant activation required", 409);
      if (error.message !== "WhatsApp connection already linked")
        throw error;
    }
    return this.waitForWhatsAppQr(options);
  }
  async waitForWhatsAppQr({
    attempts = 60,
    intervalMs = 500,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    signal,
  }: WhatsAppQrWaitOptions = {}) {
    const boundedAttempts = Math.max(1, Math.floor(attempts));
    for (let attempt = 0; attempt < boundedAttempts; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.whatsappQr(signal);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "NOT_FOUND")
          throw error;
      }
      if (attempt + 1 < boundedAttempts) {
        await sleep(Math.max(0, intervalMs));
        signal?.throwIfAborted();
      }
    }
    throw new ApiError("NOT_FOUND", "Link code not available", 404);
  }
  errorMessage(error: unknown) {
    const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    return safeMessages[code] ?? "No se pudo completar la operación.";
  }
}

export const api = new ApiClient();
