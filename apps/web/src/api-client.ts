export type Session = {
  role: "platform_admin" | "business_user";
  businessId: string | null;
};
export type Business = {
  id: string;
  name: string;
  status: "active" | "suspended";
  assistantStatus: "active" | "inactive";
  whatsappStatus: "connected" | "disconnected" | "link_required" | "error";
  createdAt: string;
  lastTechnicalActivityAt: string | null;
};
export type Profile = {
  displayName: string;
  description: string;
  address: string;
  contact: string;
  businessHours: string;
  offerings: string;
  faq: string;
  policies: string;
  additionalInfo: string;
};
export type Assistant = {
  personality: string;
  tone: string;
  instructions: string;
  knowledge: string;
  rules: string;
  restrictions: string;
  active: boolean;
  revision: number;
};
export type WhatsAppStatus = {
  status: "connected" | "disconnected" | "link_required" | "error";
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
  ): Promise<T> {
    const requestPath = composeApiPath(this.base, path);
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
        ...(method === "GET" || !csrf ? {} : { "x-csrf-token": csrf }),
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
  session = () => this.call<Session>("/auth/session");
  async logout() {
    await this.call("/auth/logout", "POST");
    this.setCsrf("");
  }
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
  profile = () => this.call<Partial<Profile>>("/me/business-profile");
  saveProfile = (body: Profile) =>
    this.call<Profile>("/me/business-profile", "PUT", body);
  assistant = () => this.call<Partial<Assistant>>("/me/assistant");
  saveAssistant = (
    body: Omit<Assistant, "revision"> & { expectedRevision: number },
  ) => this.call<Assistant>("/me/assistant", "PUT", body);
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
      if (!(error instanceof ApiError) || error.code !== "CONFLICT")
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
