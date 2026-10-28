"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  api,
  formValues,
  type Agent,
  type Business,
  type BusinessCalendar,
  type BusinessClosureRequest,
  type WeeklySchedule,
  type Profile,
  type PlatformAiInstructions,
  type Session,
  type Service,
  type Resource,
  type WhatsAppStatus,
} from "../api/api-client";
import { renderWhatsAppQrDataUrl } from "../features/whatsapp/qr-code";
import { LoginScreen } from "../features/auth/login-screen";
import {
  AuthenticatedShell,
  TerminalAuthenticatedState,
} from "./authenticated-shell";
import { AdminBusinessesScreen } from "../features/administration/admin-businesses-screen";
import { AgentScreen } from "../features/agent-settings/agent-screen";
import { ProfileScreen } from "../features/business-profile/profile-screen";
import { ServicesScreen } from "../features/services/services-screen";
import { ClientsScreen } from "../features/clients/clients-screen";
import { TurnosScreen } from "../features/appointments/turnos-screen";
import { ResourcesScreen } from "../features/resources/resources-screen";
import { BusinessCalendarScreen } from "../features/business-calendar/business-calendar-screen";
import type { ClosureReadState } from "../features/business-calendar/business-closures-section";
import { WhatsAppScreen } from "../features/whatsapp/whatsapp-screen";

export { formatActivityTimestamp } from "../features/administration/admin-businesses-screen";

type Mode = "login" | "admin" | "profile" | "services" | "resources" | "business-calendar" | "clients" | "turnos" | "agent" | "whatsapp";
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
] as const;
const agentFields = [
  "style",
  "businessInstructions",
  "active",
] as const;
type AdminData = { businesses: Business[]; instructions: PlatformAiInstructions };
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
    [agentPending, setAgentPending] = useState(false),
    [agentConflict, setAgentConflict] = useState(false),
    [viewState, setViewState] = useState<AuthenticatedViewState>("loading");

  const monitorRef = useRef<AbortController | null>(null);
  const loginPendingRef = useRef(false);
  const logoutPendingRef = useRef(false);
  const profilePendingRef = useRef(false);
  const profileSaveAttemptRef = useRef(0);
  const agentPendingRef = useRef(false);
  const agentSaveAttemptRef = useRef(0);
  const loadAttemptRef = useRef(0);
  const adminRequestRef = useRef<number | null>(null);
  const adminAttemptRef = useRef(0);
  const [adminPending, setAdminPending] = useState(false);
  const [adminWarning, setAdminWarning] = useState(false);
  const closureOwnerRef = useRef<{ businessId: string; generation: number } | null>(null);
  // Reads and mutations share synchronous session/request ownership.
  const closureRequestRef = useRef<AbortController | null>(null);
  const [closures, setClosures] = useState<ClosureReadState>({ status: "loading" });
  const loadClosures = async (): Promise<void> => {
    const owner = closureOwnerRef.current;
    if (!owner || mode !== "business-calendar" || logoutPendingRef.current || closureRequestRef.current) return;
    const controller = new AbortController();
    closureRequestRef.current = controller;
    const current = () => closureOwnerRef.current === owner && loadAttemptRef.current === owner.generation &&
      closureRequestRef.current === controller && !controller.signal.aborted && !logoutPendingRef.current;
    setClosures(state => state.status === "ready" ? { ...state, pending: true } : { status: "loading" });
    try {
      const records = await api.businessClosures(controller.signal);
      if (current()) setClosures({ status: "ready", closures: records, pending: false, warning: false });
    } catch (cause) {
      if (current()) setClosures(state => state.status === "ready"
        ? { ...state, pending: false, warning: true }
        : { status: "error", message: api.errorMessage(cause) });
    } finally {
      if (closureRequestRef.current === controller) closureRequestRef.current = null;
    }
  };
  const mutateClosure = async (operation:
    | { kind: "create"; input: BusinessClosureRequest }
    | { kind: "update"; id: string; input: BusinessClosureRequest }
    | { kind: "delete"; id: string }, signal: AbortSignal): Promise<boolean> => {
    const owner = closureOwnerRef.current;
    if (!owner || mode !== "business-calendar" || logoutPendingRef.current || closureRequestRef.current || signal.aborted) return false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    closureRequestRef.current = controller;
    const current = () => closureOwnerRef.current === owner && loadAttemptRef.current === owner.generation &&
      closureRequestRef.current === controller && !controller.signal.aborted && !logoutPendingRef.current;
    setClosures(state => state.status === "ready" ? { ...state, pending: true } : state);
    try {
      const saved = operation.kind === "create"
        ? await api.createBusinessClosure(operation.input, controller.signal)
        : operation.kind === "update"
          ? await api.updateBusinessClosure(operation.id, operation.input, controller.signal)
          : await api.deleteBusinessClosure(operation.id, controller.signal);
      if (!current()) return false;
      // Reconcile confirmed mutations before best-effort GET. Never invent a DTO or repeat a mutation.
      setClosures(state => {
        if (state.status !== "ready") return state;
        if (operation.kind === "delete") return { ...state,
          closures: state.closures.filter(row => row.id !== operation.id), warning: false };
        if (!saved) return state;
        return { ...state, closures: operation.kind === "update"
          ? state.closures.map(row => row.id === operation.id ? saved : row)
          : state.closures.some(row => row.id === saved.id)
            ? state.closures.map(row => row.id === saved.id ? saved : row) : [...state.closures, saved],
          warning: false };
      });
      try {
        const records = await api.businessClosures(controller.signal);
        if (current()) setClosures({ status: "ready", closures: records, pending: false, warning: false });
      } catch {
        if (current()) setClosures(state => state.status === "ready" ? { ...state, pending: false, warning: true } : state);
      }
      return current(); // A failed refresh does not undo a confirmed mutation.
    } catch (cause) {
      if (!current()) return false;
      setClosures(state => state.status === "ready" ? { ...state, pending: false } : state);
      throw cause;
    } finally {
      signal.removeEventListener("abort", abort);
      if (closureRequestRef.current === controller) {
        closureRequestRef.current = null;
        setClosures(state => state.status === "ready" ? { ...state, pending: false } : state);
      }
    }
  };
  const calendarLoadRef = useRef<AbortController | null>(null);
  const calendarRequestRef = useRef<AbortController | null>(null);
  const [calendarPending, setCalendarPending] = useState(false);
  const [calendarWarning, setCalendarWarning] = useState(false);
  const calendarAction = async (weeklySchedule?: WeeklySchedule): Promise<boolean> => {
    if (calendarRequestRef.current) return false;
    const controller = new AbortController();
    calendarRequestRef.current = controller;
    const generation = loadAttemptRef.current;
    const current = () => calendarRequestRef.current === controller &&
      !controller.signal.aborted && loadAttemptRef.current === generation;
    setCalendarPending(true);
    setError("");
    setNotice("");
    try {
      if (weeklySchedule !== undefined) {
        try {
          const confirmed = await api.saveBusinessCalendar(weeklySchedule, controller.signal);
          if (!current()) return false;
          setData(confirmed);
          setNotice("Horario guardado");
        } catch (cause) {
          if (current()) setError(api.errorMessage(cause));
          return false;
        }
      }
      try {
        const refreshed = await api.businessCalendar(controller.signal);
        if (!current()) return false;
        setData(refreshed);
        setCalendarWarning(false);
      } catch {
        if (!current()) return false;
        setCalendarWarning(true);
      }
      return true;
    } finally {
      if (current()) {
        calendarRequestRef.current = null;
        setCalendarPending(false);
      }
    }
  };
  const load = async () => {
    if (mode === "login") return;
    const attempt = ++loadAttemptRef.current;
    adminRequestRef.current = null;
    setAdminPending(false);
    setAdminWarning(false);
    agentSaveAttemptRef.current += 1;
    agentPendingRef.current = false;
    setAgentPending(false);
    closureOwnerRef.current = null;
    closureRequestRef.current?.abort();
    closureRequestRef.current = null;
    setClosures({ status: "loading" });
    calendarLoadRef.current?.abort();
    const calendarController = mode === "business-calendar" ? new AbortController() : null;
    calendarLoadRef.current = calendarController;
    const isCurrent = () => loadAttemptRef.current === attempt && !calendarController?.signal.aborted;

    setData(null);
    setNotice("");
    setError("");
    setAgentConflict(false);
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

    if (mode === "business-calendar" && session.businessId) {
      closureOwnerRef.current = { businessId: session.businessId, generation: attempt };
      void loadClosures();
    }
    let loaded: unknown;
    try {
      loaded =
        mode === "admin"
          ? { businesses: await api.businesses(), instructions: await api.platformAiInstructions() }
          : mode === "clients" || mode === "turnos"
            ? session
          : mode === "business-calendar"
            ? await api.businessCalendar(calendarController!.signal)
          : mode === "resources"
            ? await Promise.all([api.resources(), api.services()]).then(([resources, services]) => ({ resources, services }))
          : mode === "services"
            ? await api.services()
          : mode === "profile"
            ? await api.profile()
            : mode === "agent"
              ? await api.agent()
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
    setCalendarPending(false);
    setCalendarWarning(false);
    profileSaveAttemptRef.current += 1;
    profilePendingRef.current = false;
    setProfilePending(false);
    agentSaveAttemptRef.current += 1;
    agentPendingRef.current = false;
    setAgentPending(false);
    setAgentConflict(false);
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
      adminRequestRef.current = null;
      closureOwnerRef.current = null;
      closureRequestRef.current?.abort();
      closureRequestRef.current = null;
      calendarLoadRef.current?.abort();
      calendarRequestRef.current?.abort();
      calendarRequestRef.current = null;
      profileSaveAttemptRef.current += 1;
      profilePendingRef.current = false;
      agentSaveAttemptRef.current += 1;
      agentPendingRef.current = false;
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
  // Without work this only retries GETs; a confirmed write is never replayed.
  const runAdminMutation = async <T,>(
    work?: () => Promise<T>,
    success = "",
    reconcile?: (state: AdminData, saved: T) => AdminData,
  ): Promise<boolean> => {
    if (adminRequestRef.current || logoutPendingRef.current) return false;
    const request = ++adminAttemptRef.current;
    const generation = loadAttemptRef.current;
    adminRequestRef.current = request;
    const current = () => adminAttemptRef.current === request &&
      loadAttemptRef.current === generation && !logoutPendingRef.current;
    setAdminPending(true);
    setError("");
    if (work) setNotice("");
    try {
      if (work) {
        try {
          const saved = await work();
          if (!current()) return false;
          if (reconcile) setData((state: unknown) => current() ? reconcile(state as AdminData, saved) : state);
          setNotice(success);
        } catch (cause) {
          if (current()) setError(api.errorMessage(cause));
          return false;
        }
      }
      const [businesses, instructions] = await Promise.allSettled([
        api.businesses(), api.platformAiInstructions(),
      ]);
      if (!current()) return false;
      setData((state: unknown) => !current() ? state : {
        ...(state as AdminData),
        ...(businesses.status === "fulfilled" ? { businesses: businesses.value } : {}),
        ...(instructions.status === "fulfilled" ? { instructions: instructions.value } : {}),
      });
      setAdminWarning(businesses.status === "rejected" || instructions.status === "rejected");
      return true; // Failed refreshes cannot undo the confirmed write.
    } finally {
      if (current()) {
        adminRequestRef.current = null;
        setAdminPending(false);
      }
    }
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
  const submitAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (agentPendingRef.current || logoutPendingRef.current) return;

    const attempt = ++agentSaveAttemptRef.current;
    const generation = loadAttemptRef.current;
    const current = () => agentSaveAttemptRef.current === attempt &&
      loadAttemptRef.current === generation && !logoutPendingRef.current;
    agentPendingRef.current = true;
    setAgentPending(true);
    setAgentConflict(false);
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    const agent = data as Partial<Agent>;

    try {
      const savedAgent = await api.saveAgent({
        ...(formValues(form, agentFields) as Omit<Agent, "revision">),
        expectedRevision: agent.revision ?? 0,
      });
      if (!current()) return;
      setData(savedAgent);
      setAgentConflict(false);
      setNotice("Agente guardado");
    } catch (cause) {
      if (!current()) return;
      setAgentConflict(
        cause instanceof ApiError && cause.code === "CONFLICT",
      );
      setError(await api.errorMessage(cause));
    } finally {
      if (current()) {
        agentPendingRef.current = false;
        setAgentPending(false);
      }
    }
  };
  const logout = async () => {
    if (logoutPendingRef.current) return;
    logoutPendingRef.current = true;
    adminAttemptRef.current += 1;
    adminRequestRef.current = null;
    setAdminPending(false);
    agentSaveAttemptRef.current += 1;
    agentPendingRef.current = false;
    setAgentPending(false);
    const interruptedClosure = closureRequestRef.current;
    const closureOwner = closureOwnerRef.current;
    interruptedClosure?.abort();
    closureRequestRef.current = null;
    setLogoutPending(true);
    setError("");

    try {
      await api.logout();
      router.replace("/");
    } catch (cause) {
      setError(await api.errorMessage(cause));
      logoutPendingRef.current = false;
      setLogoutPending(false);
      // Only the aborted request's still-mounted session may regain manual GET recovery.
      if (mode === "admin") setAdminWarning(true);
      if (interruptedClosure && closureOwner) setClosures(state =>
        closureOwnerRef.current === closureOwner && loadAttemptRef.current === closureOwner.generation &&
        !closureRequestRef.current
          ? state.status === "ready" && state.pending
            ? { ...state, pending: false, warning: true }
            : state.status === "loading" ? { status: "error", message: api.errorMessage(cause) } : state
          : state);
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
      <LoginScreen
        feedback={feedback}
        loginPending={loginPending}
        submitAction={submitLogin}
      />
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
    const { businesses, instructions } = data as {
      businesses: Business[];
      instructions: PlatformAiInstructions;
    };
    const reconcileBusiness = (state: AdminData, saved: Business): AdminData => ({
      ...state, businesses: state.businesses.some(row => row.id === saved.id)
        ? state.businesses.map(row => row.id === saved.id ? saved : row)
        : [...state.businesses, saved],
    });
    return (
      <AuthenticatedShell
        variant="admin"
        activeHref="/businesses"
        logoutPending={logoutPending}
        logoutAction={() => void logout()}
      >
        <AdminBusinessesScreen
          businesses={businesses}
          instructions={instructions}
          saveInstructionsAction={(text, replyPacing) => runAdminMutation(
            () => api.savePlatformAiInstructions(text, replyPacing), "Instrucciones guardadas",
            (state, instructions) => ({ ...state, instructions }),
          )}
          notice={notice}
          error={error}
          refreshWarning={adminWarning}
          refreshPending={adminPending}
          retryRefreshAction={() => void runAdminMutation()}
          createAction={(input) =>
            runAdminMutation(() => api.createBusiness(input), "Negocio creado", reconcileBusiness)
          }
          renameAction={(id, name) =>
            runAdminMutation(
              () => api.renameBusiness(id, name),
              "Negocio actualizado", reconcileBusiness,
            )
          }
          replacePasswordAction={(id, password) =>
            runAdminMutation(
              () => api.replacePassword(id, password),
              "Negocio actualizado",
            )
          }
          setStatusAction={(id, status) =>
            runAdminMutation(
              () => api.setBusinessStatus(id, status),
              "Negocio actualizado", reconcileBusiness,
            )
          }
        />
      </AuthenticatedShell>
    );
  }
  if (mode === "turnos") {
    const session = data as Session;
    const generation = loadAttemptRef.current;
    return <AuthenticatedShell variant="business" activeHref="/turnos"
      logoutPending={logoutPending} logoutAction={() => void logout()}>
      {feedback}
      <TurnosScreen key={`${session.businessId}:${generation}`} disabled={logoutPending}
        sessionActive={() => !logoutPendingRef.current && loadAttemptRef.current === generation} />
    </AuthenticatedShell>;
  }
  if (mode === "clients") {
    const session = data as Session;
    const generation = loadAttemptRef.current;
    return <AuthenticatedShell variant="business" activeHref="/clients"
      logoutPending={logoutPending} logoutAction={() => void logout()}>
      {feedback}
      <ClientsScreen key={`${session.businessId}:${session.identityId}:${generation}`} disabled={logoutPending}
        businessId={session.businessId} identityId={session.identityId}
        sessionActive={() => !logoutPendingRef.current && loadAttemptRef.current === generation} />
    </AuthenticatedShell>;
  }

  if (mode === "resources") {
    const catalog = data as { resources: Resource[]; services: Service[] };
    return (
      <AuthenticatedShell variant="business" activeHref="/resources"
        logoutPending={logoutPending} logoutAction={() => void logout()}>
        <ResourcesScreen resources={catalog.resources} services={catalog.services}
          onLifecycle={async (id, action, signal) => {
            const attempt = loadAttemptRef.current;
            if (!catalog.resources.some(resource => resource.id === id)) throw new Error("Unknown resource");
            const saved = action === "retire" ? await api.retireResource(id, signal)
              : await api.setResourceStatus(id, action, signal);
            if (signal.aborted || loadAttemptRef.current !== attempt) return false;
            if (saved.id !== id) throw new Error("Unexpected resource response");
            setData((current: unknown) => ({ ...(current as typeof catalog),
              resources: (current as typeof catalog).resources.flatMap(resource =>
                resource.id !== saved.id ? [resource] : action === "retire" ? [] : [saved as Resource]),
            }));
            try {
              const resources = await api.resources(signal);
              if (!signal.aborted && loadAttemptRef.current === attempt)
                setData((current: unknown) => ({ ...(current as typeof catalog), resources }));
              return true;
            } catch {
              return false; // Committed mutation; retry GET only.
            }
          }}
          onSave={async (id, body, signal) => {
            const attempt = loadAttemptRef.current;
            if (id && !catalog.resources.some(resource => resource.id === id)) throw new Error("Unknown resource");
            const saved = id ? await api.updateResource(id, body, signal) : await api.createResource(body, signal);
            if (signal.aborted || loadAttemptRef.current !== attempt) return false;
            setData((current: unknown) => {
              const owned = current as typeof catalog;
              return { ...owned, resources: owned.resources.some(resource => resource.id === saved.id)
                ? owned.resources.map(resource => resource.id === saved.id ? saved : resource)
                : [...owned.resources, saved] };
            });
            try {
              const resources = await api.resources(signal);
              if (!signal.aborted && loadAttemptRef.current === attempt)
                setData((current: unknown) => ({ ...(current as typeof catalog), resources }));
              return true;
            } catch {
              return false; // Confirmed save; recovery repeats GET only.
            }
          }}
          onRefresh={async signal => {
            const attempt = loadAttemptRef.current;
            const resources = await api.resources(signal);
            if (!signal.aborted && loadAttemptRef.current === attempt)
              setData((current: unknown) => ({ ...(current as typeof catalog), resources }));
          }} />
      </AuthenticatedShell>
    );
  }
  if (mode === "services") {
    return (
      <AuthenticatedShell
        variant="business"
        activeHref="/services"
        logoutPending={logoutPending}
        logoutAction={() => void logout()}
      >
        <ServicesScreen
          services={data as Service[]}
          onSave={async (id, body, signal) => {
            const attempt = loadAttemptRef.current;
            const saved = id ? await api.updateService(id, body, signal) : await api.createService(body, signal);
            if (signal.aborted || loadAttemptRef.current !== attempt) return false;
            setData((current: unknown) => {
              const services = current as Service[];
              return services.some(service => service.id === saved.id)
                ? services.map(service => service.id === saved.id ? saved : service)
                : [...services, saved];
            });
            try {
              const services = await api.services(signal);
              if (!signal.aborted && loadAttemptRef.current === attempt) setData(services);
              return true;
            } catch {
              return false; // The mutation committed; only its catalog refresh failed.
            }
          }}
          onLifecycle={async (id, action, signal) => {
            const attempt = loadAttemptRef.current;
            if (!(data as Service[]).some(service => service.id === id)) throw new Error("Unknown service");
            const saved = action === "retire"
              ? await api.retireService(id, signal)
              : await api.setServiceStatus(id, action, signal);
            if (signal.aborted || loadAttemptRef.current !== attempt) return false;
            if (saved.id !== id) throw new Error("Unexpected service response");
            setData((current: unknown) => (current as Service[]).flatMap(service =>
              service.id !== saved.id ? [service] : action === "retire" ? [] : [saved as Service]));
            try {
              const services = await api.services(signal);
              if (!signal.aborted && loadAttemptRef.current === attempt) setData(services);
              return true;
            } catch {
              return false; // Committed mutation; recovery must only repeat GET.
            }
          }}
          onRefresh={async signal => {
            const attempt = loadAttemptRef.current;
            const services = await api.services(signal);
            if (!signal.aborted && loadAttemptRef.current === attempt) setData(services);
          }}
        />
        {feedback}
      </AuthenticatedShell>
    );
  }
  if (mode === "business-calendar") {
    return (
      <AuthenticatedShell variant="business" activeHref="/business-calendar"
        logoutPending={logoutPending} logoutAction={() => void logout()}>
        <BusinessCalendarScreen {...data as BusinessCalendar}
          closures={closures} retryClosures={loadClosures}
          createClosure={(input, signal) => mutateClosure({ kind: "create", input }, signal)}
          updateClosure={(id, input, signal) => mutateClosure({ kind: "update", id, input }, signal)}
          deleteClosure={(id, signal) => mutateClosure({ kind: "delete", id }, signal)}
          pending={calendarPending} error={error} notice={notice} warning={calendarWarning}
          saveAction={calendarAction} retryAction={() => calendarAction()}
          clearFeedback={() => {
            if (!calendarRequestRef.current) { setError(""); setNotice(""); }
          }} />
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
  if (mode === "agent") {
    const agent = data as Partial<Agent>;
    return (
      <AuthenticatedShell
        variant="business"
        activeHref="/agent"
        logoutPending={logoutPending}
        logoutAction={() => void logout()}
      >
        <AgentScreen
          agent={agent}
          feedback={feedback}
          conflict={agentConflict}
          savePending={agentPending}
          submitAction={submitAgent}
          reloadAction={() => void load()}
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
