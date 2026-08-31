"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  api,
  formValues,
  type Assistant,
  type Business,
  type Profile,
  type Session,
  type WhatsAppStatus,
} from "./api-client";
import { renderWhatsAppQrDataUrl } from "./qr-code";
import { Brand } from "./ui/brand";
import {
  AuthenticatedShell,
  TerminalAuthenticatedState,
} from "./ui/authenticated-shell";

type Mode = "login" | "admin" | "profile" | "assistant" | "whatsapp";
type AuthenticatedViewState =
  | "loading"
  | "ready"
  | "denied"
  | "session-recovery"
  | "load-error";
const profileFields = [
  "displayName",
  "description",
  "address",
  "contact",
  "businessHours",
  "offerings",
  "faq",
  "policies",
  "additionalInfo",
] as const;
const assistantFields = [
  "personality",
  "tone",
  "instructions",
  "knowledge",
  "rules",
  "restrictions",
  "active",
] as const;
const labels: Record<string, string> = {
  displayName: "Nombre comercial",
  description: "Descripción",
  address: "Dirección",
  contact: "Contacto",
  businessHours: "Horarios",
  offerings: "Servicios o productos",
  faq: "Preguntas frecuentes",
  policies: "Políticas",
  additionalInfo: "Información adicional",
  personality: "Personalidad",
  tone: "Tono",
  instructions: "Instrucciones",
  knowledge: "Conocimiento",
  rules: "Reglas",
  restrictions: "Restricciones",
  connected: "Conectado",
  disconnected: "Desconectado",
  link_required: "Requiere vinculación",
  error: "Error de conexión",
};
const activityFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
  hourCycle: "h23",
});
export const formatActivityTimestamp = (value: string | null) =>
  value ? activityFormatter.format(new Date(value)) : "Sin actividad";

const WHATSAPP_QR_LIFECYCLE_MS = 5 * 60_000;

export type WhatsAppLinkMonitorEvent =
  | { type: "status"; status: WhatsAppStatus }
  | { type: "qr"; dataUrl: string }
  | { type: "connected"; status: WhatsAppStatus }
  | { type: "expired" }
  | { type: "failed" }
  | { type: "cancelled" };

type WhatsAppLinkMonitorOptions = {
  initialQr: string;
  signal: AbortSignal;
  getStatus: () => Promise<WhatsAppStatus>;
  getQr: () => Promise<{ qr: string }>;
  renderQr: (qr: string) => Promise<string>;
  onEvent: (event: WhatsAppLinkMonitorEvent) => void;
  pollIntervalMs?: number;
  lifecycleMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

const waitForMonitorPoll = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });

export async function runWhatsAppLinkMonitor({
  initialQr,
  signal,
  getStatus,
  getQr,
  renderQr,
  onEvent,
  pollIntervalMs = 2_000,
  lifecycleMs = WHATSAPP_QR_LIFECYCLE_MS,
  now = Date.now,
  sleep = waitForMonitorPoll,
}: WhatsAppLinkMonitorOptions): Promise<void> {
  const startedAt = now();
  let currentQr = initialQr;
  const cancelled = () => {
    onEvent({ type: "cancelled" });
  };

  try {
    while (!signal.aborted) {
      const remainingMs = lifecycleMs - (now() - startedAt);
      if (remainingMs <= 0) {
        onEvent({ type: "expired" });
        return;
      }

      const status = await getStatus();
      if (signal.aborted) return cancelled();
      onEvent({ type: "status", status });
      if (status.status === "connected") {
        onEvent({ type: "connected", status });
        return;
      }

      try {
        const { qr } = await getQr();
        if (signal.aborted) return cancelled();
        if (qr !== currentQr) {
          const dataUrl = await renderQr(qr);
          if (signal.aborted) return cancelled();
          currentQr = qr;
          onEvent({ type: "qr", dataUrl });
        }
      } catch (error) {
        if (signal.aborted) return cancelled();
        if (!(error instanceof ApiError) || error.code !== "NOT_FOUND")
          throw error;
      }

      await sleep(Math.min(Math.max(1, pollIntervalMs), remainingMs), signal);
    }
    cancelled();
  } catch (error) {
    if (signal.aborted) return cancelled();
    onEvent({ type: "failed" });
    throw error;
  }
}

export function LivePanel({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [data, setData] = useState<unknown>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [qrDataUrl, setQrDataUrl] = useState<string | null>(null),
    [linking, setLinking] = useState(false),
    [loginPending, setLoginPending] = useState(false),
    [logoutPending, setLogoutPending] = useState(false),
    [viewState, setViewState] = useState<AuthenticatedViewState>("loading");
  const monitorRef = useRef<AbortController | null>(null);
  const loginPendingRef = useRef(false);
  const logoutPendingRef = useRef(false);
  const loadAttemptRef = useRef(0);
  const run = async (work: () => Promise<unknown>, success = "") => {
    setError("");
    try {
      const value = await work();
      if (value !== undefined) setData(value);
      setNotice(success);
      return value;
    } catch (cause) {
      setError(await api.errorMessage(cause));
    }
  };
  const load = async () => {
    if (mode === "login") return;
    const attempt = ++loadAttemptRef.current;
    const isCurrent = () => loadAttemptRef.current === attempt;

    setData(null);
    setNotice("");
    setError("");
    setQrDataUrl(null);
    setLinking(false);
    setViewState("loading");

    let session: Session;
    try {
      session = await api.session();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(await api.errorMessage(cause));
      setViewState(
        cause instanceof ApiError && cause.code === "UNAUTHENTICATED"
          ? "session-recovery"
          : "load-error",
      );
      return;
    }
    if (!isCurrent()) return;

    if ((mode === "admin") !== (session.role === "platform_admin")) {
      setError("Tu rol no permite acceder a este panel.");
      setViewState("denied");
      return;
    }

    let loaded: unknown;
    try {
      loaded =
        mode === "admin"
          ? await api.businesses()
          : mode === "profile"
            ? await api.profile()
            : mode === "assistant"
              ? await api.assistant()
              : await api.whatsappStatus();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(await api.errorMessage(cause));
      setViewState("load-error");
      return;
    }
    if (!isCurrent()) return;

    setData(loaded);
    setViewState("ready");
    if (
      mode === "whatsapp" &&
      (loaded as WhatsAppStatus).status !== "connected"
    ) {
      try {
        const { qr } = await api.whatsappQr();
        const renderedQr = await renderWhatsAppQrDataUrl(qr);
        if (isCurrent()) setQrDataUrl(renderedQr);
      } catch (cause) {
        if (
          isCurrent() &&
          (!(cause instanceof ApiError) || cause.code !== "NOT_FOUND")
        )
          setError(await api.errorMessage(cause));
      }
    }
  };
  useEffect(() => {
    monitorRef.current?.abort();
    monitorRef.current = null;
    if (mode === "login") {
      setData(null);
      setNotice("");
      setError("");
      setQrDataUrl(null);
      setLinking(false);
      setViewState("loading");
    } else void load();
    return () => {
      loadAttemptRef.current += 1;
      monitorRef.current?.abort();
      monitorRef.current = null;
    };
  }, [mode]);
  const startWhatsAppLink = async () => {
    if (monitorRef.current) return;
    const controller = new AbortController();
    let expiryTimeout: ReturnType<typeof setTimeout> | undefined;
    monitorRef.current = controller;
    setError("");
    setNotice("");
    setLinking(true);
    setQrDataUrl(null);

    try {
      const { qr } = await api.requestOrResumeWhatsAppLink({
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const initialDataUrl = await renderWhatsAppQrDataUrl(qr);
      if (controller.signal.aborted) return;
      setQrDataUrl(initialDataUrl);
      setNotice("Vinculación solicitada. Escaneá el QR desde WhatsApp.");
      expiryTimeout = setTimeout(() => {
        controller.abort();
        if (monitorRef.current !== controller) return;
        setQrDataUrl(null);
        setLinking(false);
        setNotice(
          "El código QR expiró. Solicitá uno nuevo para volver a intentar.",
        );
      }, WHATSAPP_QR_LIFECYCLE_MS);

      await runWhatsAppLinkMonitor({
        initialQr: qr,
        signal: controller.signal,
        getStatus: () => api.whatsappStatus(controller.signal),
        getQr: () => api.whatsappQr(controller.signal),
        renderQr: renderWhatsAppQrDataUrl,
        lifecycleMs: WHATSAPP_QR_LIFECYCLE_MS,
        onEvent: (event) => {
          if (event.type === "status") setData(event.status);
          else if (event.type === "qr") setQrDataUrl(event.dataUrl);
          else if (event.type === "connected") {
            setData(event.status);
            setQrDataUrl(null);
            setLinking(false);
            setNotice("WhatsApp conectado correctamente.");
          } else if (event.type === "expired") {
            setQrDataUrl(null);
            setLinking(false);
            setNotice(
              "El código QR expiró. Solicitá uno nuevo para volver a intentar.",
            );
          } else if (event.type === "failed") {
            setQrDataUrl(null);
            setLinking(false);
            setNotice("");
          }
        },
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        setQrDataUrl(null);
        setLinking(false);
        setNotice("");
        setError(await api.errorMessage(cause));
      }
    } finally {
      if (expiryTimeout) clearTimeout(expiryTimeout);
      if (monitorRef.current === controller) monitorRef.current = null;
    }
  };
  const submit =
    (work: (form: FormData) => Promise<unknown>, success: string) =>
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await run(() => work(form), success);
    };
  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginPendingRef.current) return;

    loginPendingRef.current = true;
    setLoginPending(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);

    try {
      const session = await api.login(
        String(form.get("email")),
        String(form.get("password")),
      );
      if (session.role === "platform_admin") router.replace("/businesses");
      else router.replace("/profile");
    } catch (cause) {
      setError(await api.errorMessage(cause));
      loginPendingRef.current = false;
      setLoginPending(false);
    }
  };
  const logout = async () => {
    if (logoutPendingRef.current) return;
    logoutPendingRef.current = true;
    setLogoutPending(true);
    setError("");

    try {
      await api.logout();
      router.replace("/");
    } catch (cause) {
      setError(await api.errorMessage(cause));
      logoutPendingRef.current = false;
      setLogoutPending(false);
    }
  };
  const feedback = (
    <>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </>
  );

  if (mode === "login")
    return (
      <main className="login-frame" data-ui="login-frame">
        <section
          className="login-form-panel"
          data-ui="login-form-panel"
          aria-labelledby="login-title"
        >
          <div className="login-card">
            <Brand />
            <h1 id="login-title">Iniciar sesión</h1>
            {feedback}
            <form onSubmit={submitLogin} aria-busy={loginPending}>
              <label className="login-field">
                Correo
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  required
                />
              </label>
              <label className="login-field">
                Contraseña
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  minLength={16}
                  required
                />
              </label>
              <button
                className="login-submit"
                type="submit"
                disabled={loginPending}
              >
                {loginPending ? "Ingresando…" : "Ingresar"}
              </button>
            </form>
          </div>
        </section>
        <aside
          className="login-story"
          data-ui="login-story"
          aria-labelledby="login-story-title"
        >
          <Brand className="login-story__brand" inverse />
          <div className="login-story__content">
            <p className="login-story__eyebrow">
              Tu asistente inteligente para WhatsApp
            </p>
            <h2 id="login-story-title">
              <span data-ui="login-story-heading-primary">Atendé mejor.</span>{" "}
              <span data-ui="login-story-heading-accent">
                Sin estar pendiente.
              </span>
            </h2>
            <p className="login-story__copy">
              Menos tiempo pendiente del teléfono. Más tiempo para dedicarle a
              tu negocio.
            </p>
          </div>
        </aside>
      </main>
    );
  if (viewState !== "ready")
    return (
      <TerminalAuthenticatedState
        state={viewState}
        message={error}
        retryAction={() => void load()}
      />
    );

  if (mode === "admin") {
    const rows = data as Business[];
    return (
      <AuthenticatedShell
        variant="admin"
        activeHref="/businesses"
        logoutPending={logoutPending}
        logoutAction={() => void logout()}
      >
        <main>
          <h1>Negocios</h1>
          <p>Supervisión sin acceso a conversaciones ni secretos.</p>
          {feedback}
          <form
            onSubmit={submit(async (form) => {
              await api.createBusiness({
                name: String(form.get("name")),
                userEmail: String(form.get("userEmail")),
                initialPassword: String(form.get("initialPassword")),
              });
              return api.businesses();
            }, "Negocio creado")}
          >
            <label>
              Nombre
              <input name="name" required />
            </label>
            <label>
              Correo del usuario
              <input name="userEmail" type="email" required />
            </label>
            <label>
              Contraseña inicial
              <input
                name="initialPassword"
                type="password"
                minLength={16}
                required
              />
            </label>
            <button>Crear negocio</button>
          </form>
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Negocio</th>
                <th>Asistente</th>
                <th>WhatsApp</th>
                <th>Creación</th>
                <th>Última actividad técnica</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((business) => (
                <tr key={business.id}>
                  <td>{business.name}</td>
                  <td>{business.status}</td>
                  <td>{business.assistantStatus}</td>
                  <td>{business.whatsappStatus}</td>
                  <td>{business.createdAt}</td>
                  <td>
                    {formatActivityTimestamp(business.lastTechnicalActivityAt)}
                  </td>
                  <td>
                    <form
                      onSubmit={submit(async (form) => {
                        const action = String(form.get("action"));
                        if (action === "rename")
                          await api.renameBusiness(
                            business.id,
                            String(form.get("name")),
                          );
                        else if (action === "password")
                          await api.replacePassword(
                            business.id,
                            String(form.get("password")),
                          );
                        else
                          await api.setBusinessStatus(
                            business.id,
                            business.status === "active"
                              ? "suspended"
                              : "active",
                          );
                        return api.businesses();
                      }, "Negocio actualizado")}
                    >
                      <input
                        name="name"
                        aria-label={`Nombre de ${business.name}`}
                        defaultValue={business.name}
                      />
                      <button name="action" value="rename">
                        Renombrar
                      </button>
                      <input
                        name="password"
                        type="password"
                        minLength={16}
                        aria-label={`Nueva contraseña de ${business.name}`}
                      />
                      <button name="action" value="password">
                        Cambiar contraseña
                      </button>
                      <button name="action" value="status">
                        {business.status === "active"
                          ? "Suspender"
                          : "Reactivar"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </main>
      </AuthenticatedShell>
    );
  }
  if (mode === "profile") {
    const profile = data as Partial<Profile>;
    return (
      <AuthenticatedShell
        variant="business"
        activeHref="/profile"
        logoutPending={logoutPending}
        logoutAction={() => void logout()}
      >
        <main>
          <h1>Información del negocio</h1>
          {feedback}
          <form
            onSubmit={submit(
              (form) =>
                api.saveProfile(formValues(form, profileFields) as Profile),
              "Perfil guardado",
            )}
          >
            {profileFields.map((field) => (
              <label key={field}>
                {labels[field]}
                <textarea
                  name={field}
                  defaultValue={profile[field] ?? ""}
                  required={field === "displayName"}
                />
              </label>
            ))}
            <button>Guardar perfil</button>
          </form>
        </main>
      </AuthenticatedShell>
    );
  }
  if (mode === "assistant") {
    const assistant = data as Partial<Assistant>;
    return (
      <AuthenticatedShell
        variant="business"
        activeHref="/assistant"
        logoutPending={logoutPending}
        logoutAction={() => void logout()}
      >
        <main>
          <h1>Asistente</h1>
          {feedback}
          <form
            onSubmit={submit(
              (form) =>
                api.saveAssistant({
                  ...(formValues(form, assistantFields) as Omit<
                    Assistant,
                    "revision"
                  >),
                  expectedRevision: assistant.revision ?? 0,
                }),
              "Asistente guardado",
            )}
          >
            <p>Un asistente activo opera las 24 horas.</p>
            {assistantFields.slice(0, -1).map((field) => (
              <label key={field}>
                {labels[field]}
                <textarea
                  name={field}
                  defaultValue={String(assistant[field] ?? "")}
                />
              </label>
            ))}
            <label>
              <input
                name="active"
                type="checkbox"
                defaultChecked={assistant.active}
              />{" "}
              Respuestas automáticas activas
            </label>
            <button>Guardar y activar</button>
          </form>
        </main>
      </AuthenticatedShell>
    );
  }
  const whatsapp = data as WhatsAppStatus;
  return (
    <AuthenticatedShell
      variant="business"
      activeHref="/whatsapp"
      logoutPending={logoutPending}
      logoutAction={() => void logout()}
    >
      <main>
        <h1>WhatsApp</h1>
        {feedback}
        <p role="status">{labels[whatsapp.status]}</p>
        <p>El QR es temporal y nunca expone credenciales persistentes.</p>
        <button
          disabled={whatsapp.status === "connected" || linking}
          onClick={() => void startWhatsAppLink()}
        >
          {whatsapp.status === "connected"
            ? "WhatsApp vinculado"
            : linking
              ? "Esperando conexión…"
              : "Vincular WhatsApp"}
        </button>
        {qrDataUrl && (
          <img
            src={qrDataUrl}
            alt="Código QR temporal de WhatsApp"
            aria-label="Código QR temporal de WhatsApp"
            width={384}
            height={384}
          />
        )}
      </main>
    </AuthenticatedShell>
  );
}
