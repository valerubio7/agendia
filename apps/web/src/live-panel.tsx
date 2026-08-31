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
import { AssistantScreen } from "./ui/assistant-screen";
import { ProfileScreen } from "./ui/profile-screen";
import { WhatsAppScreen } from "./ui/whatsapp-screen";

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
    [profilePending, setProfilePending] = useState(false),
    [assistantPending, setAssistantPending] = useState(false),
    [viewState, setViewState] = useState<AuthenticatedViewState>("loading");
  const monitorRef = useRef<AbortController | null>(null);
  const loginPendingRef = useRef(false);
  const logoutPendingRef = useRef(false);
  const profilePendingRef = useRef(false);
  const profileSaveAttemptRef = useRef(0);
  const assistantPendingRef = useRef(false);
  const assistantSaveAttemptRef = useRef(0);
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
    profileSaveAttemptRef.current += 1;
    profilePendingRef.current = false;
    setProfilePending(false);
    assistantSaveAttemptRef.current += 1;
    assistantPendingRef.current = false;
    setAssistantPending(false);
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
      profileSaveAttemptRef.current += 1;
      profilePendingRef.current = false;
      assistantSaveAttemptRef.current += 1;
      assistantPendingRef.current = false;
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
  const submitProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (profilePendingRef.current) return;

    const attempt = ++profileSaveAttemptRef.current;
    profilePendingRef.current = true;
    setProfilePending(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);

    try {
      const savedProfile = await api.saveProfile(
        formValues(form, profileFields) as Profile,
      );
      if (profileSaveAttemptRef.current !== attempt) return;
      setData(savedProfile);
      setNotice("Perfil guardado");
    } catch (cause) {
      if (profileSaveAttemptRef.current !== attempt) return;
      setError(await api.errorMessage(cause));
    } finally {
      if (profileSaveAttemptRef.current === attempt) {
        profilePendingRef.current = false;
        setProfilePending(false);
      }
    }
  };
  const submitAssistant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (assistantPendingRef.current) return;

    const attempt = ++assistantSaveAttemptRef.current;
    assistantPendingRef.current = true;
    setAssistantPending(true);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    const assistant = data as Partial<Assistant>;

    try {
      const savedAssistant = await api.saveAssistant({
        ...(formValues(form, assistantFields) as Omit<Assistant, "revision">),
        expectedRevision: assistant.revision ?? 0,
      });
      if (assistantSaveAttemptRef.current !== attempt) return;
      setData(savedAssistant);
      setNotice("Asistente guardado");
    } catch (cause) {
      if (assistantSaveAttemptRef.current !== attempt) return;
      setError(await api.errorMessage(cause));
    } finally {
      if (assistantSaveAttemptRef.current === attempt) {
        assistantPendingRef.current = false;
        setAssistantPending(false);
      }
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
        <ProfileScreen
          profile={profile}
          feedback={feedback}
          savePending={profilePending}
          submitAction={submitProfile}
        />
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
        <AssistantScreen
          assistant={assistant}
          feedback={feedback}
          savePending={assistantPending}
          submitAction={submitAssistant}
        />
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
      <WhatsAppScreen
        status={whatsapp}
        feedback={feedback}
        qrDataUrl={qrDataUrl}
        linking={linking}
        linkAction={() => void startWhatsAppLink()}
      />
    </AuthenticatedShell>
  );
}
