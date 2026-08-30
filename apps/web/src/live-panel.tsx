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

type Mode = "login" | "admin" | "profile" | "assistant" | "whatsapp";
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

const businessOnboardingSteps = [
  { mode: "profile", href: "/profile", label: "Completar perfil" },
  { mode: "assistant", href: "/assistant", label: "Configurar asistente" },
  { mode: "whatsapp", href: "/whatsapp", label: "Vincular WhatsApp" },
] as const;

function BusinessOnboardingNavigation({
  mode,
}: {
  mode: "profile" | "assistant" | "whatsapp";
}) {
  return (
    <nav aria-label="Pasos de configuración del negocio">
      <ol>
        {businessOnboardingSteps.map((step) => (
          <li key={step.mode}>
            <a
              href={step.href}
              aria-current={mode === step.mode ? "page" : undefined}
            >
              {step.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function LivePanel({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [data, setData] = useState<unknown>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [qrDataUrl, setQrDataUrl] = useState<string | null>(null),
    [linking, setLinking] = useState(false);
  const monitorRef = useRef<AbortController | null>(null);
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
    let session: Session;
    try {
      session = await api.session();
    } catch (cause) {
      setError(await api.errorMessage(cause));
      return;
    }
    if ((mode === "admin") !== (session.role === "platform_admin"))
      return setError("Tu rol no permite acceder a este panel.");
    const loaded = await run(() =>
      mode === "admin"
        ? api.businesses()
        : mode === "profile"
          ? api.profile()
          : mode === "assistant"
            ? api.assistant()
            : api.whatsappStatus(),
    );
    if (
      mode === "whatsapp" &&
      loaded &&
      (loaded as WhatsAppStatus).status !== "connected"
    ) {
      try {
        const { qr } = await api.whatsappQr();
        setQrDataUrl(await renderWhatsAppQrDataUrl(qr));
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.code !== "NOT_FOUND")
          setError(await api.errorMessage(cause));
      }
    }
  };
  useEffect(() => {
    setQrDataUrl(null);
    setLinking(false);
    void load();
    return () => {
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
  const feedback = (
    <>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </>
  );

  if (mode === "login")
    return (
      <main>
        <h1>Iniciar sesión</h1>
        {feedback}
        <form
          onSubmit={submit(async (form) => {
            const session = await api.login(
              String(form.get("email")),
              String(form.get("password")),
            );
            if (session.role === "platform_admin")
              router.replace("/businesses");
            else router.replace("/profile");
          }, "Sesión iniciada")}
        >
          <label>
            Correo
            <input name="email" type="email" required />
          </label>
          <label>
            Contraseña
            <input name="password" type="password" minLength={16} required />
          </label>
          <button>Ingresar</button>
        </form>
      </main>
    );
  if (!data)
    return (
      <main>
        <h1>AgendIA</h1>
        {feedback}
        <p role="status">Cargando panel…</p>
      </main>
    );

  if (mode === "admin") {
    const rows = data as Business[];
    return (
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
                          business.status === "active" ? "suspended" : "active",
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
                      {business.status === "active" ? "Suspender" : "Reactivar"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    );
  }
  if (mode === "profile") {
    const profile = data as Partial<Profile>;
    return (
      <main>
        <h1>Información del negocio</h1>
        <BusinessOnboardingNavigation mode="profile" />
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
    );
  }
  if (mode === "assistant") {
    const assistant = data as Partial<Assistant>;
    return (
      <main>
        <h1>Asistente</h1>
        <BusinessOnboardingNavigation mode="assistant" />
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
    );
  }
  const whatsapp = data as WhatsAppStatus;
  return (
    <main>
      <h1>WhatsApp</h1>
      <BusinessOnboardingNavigation mode="whatsapp" />
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
  );
}
