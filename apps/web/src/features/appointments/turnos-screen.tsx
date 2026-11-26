"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type AppointmentRecord, type AppointmentOperationContext, type AppointmentOperationReceipt, type Service, type Resource, type Client } from "../../api/api-client";
import { useOutsideDismiss } from "../../components/dialog-dismiss";
import { PanelInlineError, PanelToast } from "../../components/panel-feedback";
import { BusinessHome } from "./business-home";
import { TurnosBookingForm } from "./turnos-booking-form";
import { TurnosDetail } from "./turnos-detail";
import { AgendaIcon, AgendaViewContent } from "./agenda-view";
import { agendaDates, type AgendaSchedule, type AgendaView } from "./agenda-calendar";
import { argentinaDate, dayBounds } from "./turnos-calendar";

export type TurnosMutation = (save: (signal: AbortSignal) => Promise<AppointmentRecord>) => Promise<boolean>;
type Read<T> = { value: T; pending: boolean; error: string };
type Operation = AppointmentOperationContext & { businessId: string; identityId: string };
const read = <T,>(value: T): Read<T> => ({ value, pending: false, error: "" });
const unknownMessage = "No pudimos confirmar el resultado. El turno podría haberse guardado. Consultá el resultado guardado; no repetimos la operación.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory intent from the authenticated Clients screen, never from the URL.
export type ClientTurno = ({ client: Client } | { appointmentId: string }) & { trigger: HTMLButtonElement };

type ClientFlow = { target: ClientTurno | null; close: () => void };
type TurnosProps = { disabled: boolean; sessionActive: () => boolean; clientFlow?: ClientFlow };
const ClientHandoff = createContext<((flow: ClientFlow & { sessionActive: () => boolean }) => void) | null>(null);

export function FloatingTurnos({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const active = useRef(!disabled);
  const [handoff, setHandoff] = useState<(ClientFlow & { sessionActive: () => boolean }) | null>(null);
  useLayoutEffect(() => {
    active.current = !disabled;
    return () => { active.current = false; };
  }, [disabled]);
  return <ClientHandoff.Provider value={setHandoff}>
    <TurnosWorkspace floating disabled={disabled || !!handoff && !handoff.sessionActive()}
      sessionActive={() => active.current && (handoff?.sessionActive() ?? true)}
      {...(handoff && { clientFlow: { target: handoff.target, close: () => { setHandoff(null); handoff.close(); } } })} />
    {children}
  </ClientHandoff.Provider>;
}

export function TurnosScreen(props: TurnosProps) {
  const handoff = useContext(ClientHandoff);
  const target = props.clientFlow?.target;
  useEffect(() => {
    if (handoff && target && props.clientFlow && props.sessionActive()) handoff({ ...props.clientFlow, sessionActive: props.sessionActive });
  }, [handoff, target]);
  return handoff && props.clientFlow ? null : <TurnosWorkspace {...props} />;
}

function TurnosWorkspace({ disabled, sessionActive, clientFlow, floating = false }: TurnosProps & { floating?: boolean }) {
  const home = usePathname() === "/inicio";
  const embedded = floating || !!clientFlow;
  const [loadedHomeDate, setLoadedHomeDate] = useState("");
  const [view, setView] = useState<AgendaView>("day");
  const [selectedDate, setDate] = useState<string | null>(null);
  const [resource, setResource] = useState("");
  const [schedule, setSchedule] = useState(() => read<AgendaSchedule | null>(null));
  const [loadedAgendaRange, setLoadedAgendaRange] = useState<{ from: string; to: string } | null>(null);
  const [list, setList] = useState(() => read<AppointmentRecord[]>([]));
  const [detail, setDetail] = useState(() => read<AppointmentRecord | null>(null));
  const [catalog, setCatalog] = useState(() => read<{ services: Service[]; resources: Resource[] }>({ services: [], resources: [] }));
  const [editor, setEditor] = useState<"create" | "change" | null>(null);
  const [pending, setPending] = useState(false), [scopeReady, setScopeReady] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [toast, setToast] = useState<{ revision: number; message: string; error: boolean } | null>(null);
  const showToast = (message: string, error = false) =>
    setToast(previous => ({ revision: (previous?.revision ?? 0) + 1, message, error }));
  const announceSaved = () => {
    setNotice("Turno guardado");
    showToast("Turno guardado");
  };
  const [operations, setOperations] = useState<Operation[]>([]);
  const operationRef = useRef<Operation[]>([]);
  const [inspection, setInspection] = useState<Record<string, string>>({});
  const [reading, setReading] = useState<string[]>([]), [fence, setFence] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<Record<string, "pending" | "failed">>({});
  const freshnessRef = useRef(new Set<string>());
  const currentRequests = useRef(new Map<string, AbortController>());
  const projectionRevision = useRef(0);
  const [now, setNow] = useState(Date.now);
  const owner = useRef(0), mounted = useRef(false);
  const scope = useRef<{ storage: string; businessId: string; identityId: string } | null>(null);
  const scopeRequest = useRef<AbortController | null>(null);
  const listRequest = useRef<AbortController | null>(null), detailRequest = useRef<AbortController | null>(null);
  const catalogRequest = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null);
  const scheduleRequest = useRef<AbortController | null>(null);
  const receiptRequests = useRef(new Map<string, AbortController>());
  const selected = useRef<string | null>(null), range = useRef({ from: "", to: "" });
  const heading = useRef<HTMLHeadingElement>(null), createButton = useRef<HTMLButtonElement>(null);
  const [dialogVisible, setDialogVisible] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), dialogHeading = useRef<HTMLHeadingElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const revealDialog = (trigger?: HTMLButtonElement) => {
    if (!dialog.current?.open) invoker.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setDialogVisible(true);
  };
  useLayoutEffect(() => {
    const surface = dialog.current;
    if (!surface) return;
    if (dialogVisible) {
      if (!surface.open) surface.showModal();
      dialogHeading.current?.focus();
    } else if (surface.open) {
      surface.close();
      const target = invoker.current;
      if (target?.isConnected && !target.matches(":disabled, [hidden]") && target.getClientRects().length) target.focus();
      else heading.current?.focus();
    }
  }, [dialogVisible, editor]);
  const [focusRevision, setFocusRevision] = useState(0);
  const focus = useRef<"create" | "detail" | "heading" | null>(null);
  const scheduleFocus = (target: typeof focus.current) => { focus.current = target; setFocusRevision(value => value + 1); };
  useEffect(() => {
    const target = focus.current; focus.current = null;
    if (!target || disabled || !sessionActive() || (target === "detail" && !dialog.current?.open)) return;
    const element = dialog.current?.open
      ? target === "detail" && !editor ? document.getElementById("turnos-detail-title") ?? dialogHeading.current : dialogHeading.current
      : target === "create" ? createButton.current : heading.current;
    if (element?.isConnected && !(element instanceof HTMLButtonElement && element.disabled)) element.focus();
  }, [focusRevision]);
  const owns = (generation: number, controller: AbortController) =>
    mounted.current && owner.current === generation && !controller.signal.aborted && sessionActive();
  const storeOperations = (next: Operation[]) => {
    if (!scope.current) throw new Error("Missing operation owner");
    try { sessionStorage.setItem(scope.current.storage, JSON.stringify(next)); }
    catch (cause) { setScopeReady(false); throw cause; }
    operationRef.current = next; setOperations(next);
  };
  const blocked = (kind: AppointmentOperationContext["kind"], target: string | null) =>
    (target !== null && freshnessRef.current.has(target))
    || operationRef.current.some(op => kind === "create" ? op.kind === "create" : op.target === target);
  const loadScope = async () => {
    if (scopeRequest.current || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    scopeRequest.current = controller;
    try {
      // The receipt response supplies server-authenticated actor scope; UUIDs are not authority.
      const session = await api.appointmentOperation(crypto.randomUUID(), controller.signal);
      if (!owns(generation, controller) || scopeRequest.current !== controller) return;
      const storage = `agendia.turnos.operations.${session.businessId}.${session.identityId}`;
      const stored: unknown = JSON.parse(sessionStorage.getItem(storage) ?? "[]");
      if (!Array.isArray(stored) || !stored.every(op => op && typeof op === "object"
        && op.businessId === session.businessId && op.identityId === session.identityId && uuid.test(op.key)
        && ["create", "change", "notes", "state"].includes(op.kind)
        && (op.kind === "create" ? op.target === null : typeof op.target === "string" && uuid.test(op.target))))
        throw new Error("Invalid operation storage");
      scope.current = { storage, businessId: session.businessId, identityId: session.identityId };
      operationRef.current = stored as Operation[]; setOperations(stored as Operation[]);
      // Only the unreleased candidate used this obsolete, uncorrelated global marker format.
      sessionStorage.removeItem(`agendia.turnos.outcome.${session.businessId}`);
      if (stored.length) setError(unknownMessage);
      setScopeReady(true);
    } catch (cause) {
      if (owns(generation, controller) && scopeRequest.current === controller) {
        setScopeReady(false); setError(cause instanceof ApiError ? api.errorMessage(cause) : "No pudimos verificar la protección de las operaciones. Solo se permite consultar.");
      }
    } finally { if (scopeRequest.current === controller) scopeRequest.current = null; }
  };
  const loadList = async () => {
    if (embedded || mutation.current || listRequest.current || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current, bounds = range.current, revision = projectionRevision.current;
    listRequest.current = controller; setList(state => ({ ...state, pending: true, error: "" }));
    try {
      const rows = await api.appointments(home ? bounds : { ...bounds, overlap: true }, controller.signal);
      if (owns(generation, controller) && listRequest.current === controller && range.current === bounds) {
        if (projectionRevision.current === revision) {
          if (home) setLoadedHomeDate(argentinaDate(Date.parse(bounds.from)));
          else setLoadedAgendaRange(bounds);
          setList(state => read([
            ...rows.filter(row => !freshnessRef.current.has(row.id)),
            ...state.value.filter(row => freshnessRef.current.has(row.id)),
          ]));
        } else setList(state => ({ ...state, pending: false }));
      }
    } catch (cause) {
      if (owns(generation, controller) && listRequest.current === controller)
        setList(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally { if (listRequest.current === controller) listRequest.current = null; }
  };
  const loadDetail = async (id = selected.current, focusDetail = false) => {
    if (disabled || !id || mutation.current || detailRequest.current || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    detailRequest.current = controller; setDetail(state => ({ ...state, pending: true, error: "" }));
    try {
      const row = await api.appointment(id, controller.signal);
      if (row.id !== id) throw new Error("Current appointment identity differs");
      if (owns(generation, controller) && detailRequest.current === controller && selected.current === id && !freshnessRef.current.has(id)) {
        setDetail(read(row)); if (focusDetail) scheduleFocus("detail");
      }
    } catch (cause) {
      if (owns(generation, controller) && detailRequest.current === controller && selected.current === id)
        setDetail(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally { if (detailRequest.current === controller) detailRequest.current = null; }
  };
  const loadCatalog = async () => {
    if (catalogRequest.current || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    catalogRequest.current = controller; setCatalog(state => ({ ...state, pending: true, error: "" }));
    try {
      const [services, resources] = await Promise.all([api.services(controller.signal), api.resources(controller.signal)]);
      if (owns(generation, controller) && catalogRequest.current === controller) setCatalog(read({ services, resources }));
    } catch (cause) {
      if (owns(generation, controller) && catalogRequest.current === controller)
        setCatalog(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally { if (catalogRequest.current === controller) catalogRequest.current = null; }
  };
  const loadSchedule = async () => {
    if (scheduleRequest.current || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    scheduleRequest.current = controller;
    setSchedule(state => ({ ...state, pending: true, error: "" }));
    try {
      const [calendar, closures, resources] = await Promise.all([
        api.businessCalendar(controller.signal), api.businessClosures(controller.signal), api.resources(controller.signal),
      ]);
      if (owns(generation, controller)) {
        setSchedule(read({ calendar, closures, resources }));
        setResource(id => resources.some(item => item.id === id && item.status === "active") ? id : "");
      }
    } catch (cause) {
      if (owns(generation, controller)) setSchedule(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally { if (scheduleRequest.current === controller) scheduleRequest.current = null; }
  };
  const abortOwned = () => {
    for (const ref of [scopeRequest, listRequest, detailRequest, catalogRequest, scheduleRequest, mutation]) {
      const controller = ref.current; controller?.abort();
      if (ref.current === controller) ref.current = null;
    }
    for (const [id, controller] of currentRequests.current) {
      controller.abort(); if (currentRequests.current.get(id) === controller) currentRequests.current.delete(id);
    }
    for (const [key, controller] of receiptRequests.current) {
      controller.abort(); if (receiptRequests.current.get(key) === controller) receiptRequests.current.delete(key);
    }
  };
  useEffect(() => {
    mounted.current = true;
    const clock = () => setNow(Date.now()), timer = setInterval(clock, 15_000);
    window.addEventListener("focus", clock); document.addEventListener("visibilitychange", clock);
    return () => {
      mounted.current = false; owner.current++; abortOwned(); clearInterval(timer);
      window.removeEventListener("focus", clock); document.removeEventListener("visibilitychange", clock);
    };
  }, []);
  useEffect(() => {
    if (!disabled) { void loadScope(); return; }
    owner.current++; abortOwned(); setScopeReady(false); setPending(false); setReading([]); setToast(null);
    setFreshness(state => Object.fromEntries(Object.keys(state).map(id => [id, "failed" as const])));
    setList(state => ({ ...state, pending: false, error: "Lectura interrumpida. Actualizá los turnos." }));
    setDetail(state => ({ ...state, pending: false, error: selected.current ? "Lectura interrumpida. Actualizá el detalle." : "" }));
    setCatalog(state => ({ ...state, pending: false }));
    setSchedule(state => ({ ...state, pending: false }));
  }, [disabled]);
  useEffect(() => { if (!embedded && !home && !disabled) void loadSchedule(); }, [embedded, home, disabled]);
  const today = argentinaDate(now), agendaDate = selectedDate ?? today;
  const dates = home ? [today] : agendaDates(agendaDate, view);
  const first = dates[0]!, last = dates.at(-1)!;
  const listReady = scopeReady && !disabled && !pending && !list.pending && !list.error
    && !operations.length && !Object.keys(freshness).length && !!loadedAgendaRange
    && argentinaDate(Date.parse(loadedAgendaRange.from)) === first
    && argentinaDate(Date.parse(loadedAgendaRange.to) - 1) === last;
  useEffect(() => {
    listRequest.current?.abort(); listRequest.current = null;
    range.current = { from: dayBounds(first).from, to: dayBounds(last).to }; void loadList();
  }, [home, first, last]);
  const installSaved = (saved: AppointmentRecord, show = true) => {
    setList(state => ({ ...state, value: [...state.value.filter(row => row.id !== saved.id), saved], pending: false }));
    if (show) { selected.current = saved.id; setDetail(read(saved)); setEditor(null); scheduleFocus("detail"); }
    announceSaved();
  };
  const loadCurrent = async (id: string, focusDetail = false) => {
    if (disabled || mutation.current || currentRequests.current.has(id) || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    currentRequests.current.set(id, controller);
    setFreshness(state => ({ ...state, [id]: "pending" }));
    try {
      const current = await api.appointment(id, controller.signal);
      if (!owns(generation, controller) || currentRequests.current.get(id) !== controller) return;
      if (current.id !== id) throw new Error("Current appointment identity differs");
      projectionRevision.current++;
      setList(state => ({ ...state, value: [...state.value.filter(row => row.id !== id), current] }));
      if (selected.current === id) { setDetail(read(current)); if (focusDetail) scheduleFocus("detail"); }
      freshnessRef.current.delete(id);
      announceSaved();
      setFreshness(state => { const next = { ...state }; delete next[id]; return next; });
      if (!home) {
        listRequest.current?.abort(); listRequest.current = null;
        void loadList();
      }
    } catch (cause) {
      if (owns(generation, controller) && currentRequests.current.get(id) === controller)
        setFreshness(state => ({ ...state, [id]: "failed" }));
    } finally { if (currentRequests.current.get(id) === controller) currentRequests.current.delete(id); }
  };
  const recover = async (op: Operation, cancel = false, quiet = false) => {
    if (disabled || mutation.current || receiptRequests.current.has(op.key) || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    receiptRequests.current.set(op.key, controller); setReading(keys => [...keys, op.key]);
    try {
      const receipt: AppointmentOperationReceipt = cancel ? await api.cancelAppointmentOperation(op, controller.signal)
        : await api.appointmentOperation(op.key, controller.signal);
      if (!owns(generation, controller) || receiptRequests.current.get(op.key) !== controller || !operationRef.current.some(item => item.key === op.key)) return;
      if (receipt.businessId !== op.businessId || receipt.identityId !== op.identityId
        || (receipt.kind !== null && (receipt.kind !== op.kind || receipt.target !== op.target))) throw new Error("Operation owner/context differs");
      if (receipt.state === "completed" || receipt.state === "failed" || receipt.state === "cancelled") {
        // Only a terminal receipt (including a serialized fence) releases the matching intent.
        let currentId: string | null = null;
        if (receipt.state === "completed" && receipt.appointment) {
          // A receipt proves this operation's historical result, not the record's current state.
          currentId = receipt.appointment.id;
          if (op.target !== null && currentId !== op.target) throw new Error("Receipt appointment identity differs");
          freshnessRef.current.add(currentId);
          setFreshness(state => ({ ...state, [currentId!]: "pending" }));
          projectionRevision.current++;
          listRequest.current?.abort(); listRequest.current = null;
          detailRequest.current?.abort(); detailRequest.current = null;
          setList(state => ({ ...state, pending: false })); setDetail(state => ({ ...state, pending: false }));
          if (op.kind === "create" && editor === "create") {
            selected.current = currentId; setDetail(read(null)); setEditor(null);
          }
          setNotice("Operación guardada. Verificando el estado actual del turno…");
        }
        storeOperations(operationRef.current.filter(item => item.key !== op.key));
        setFence(null);
        const rejection = receipt.state === "failed" ? api.errorMessage(new ApiError(receipt.error!.code, receipt.error!.message, receipt.httpStatus!)) : "";
        setError(rejection);
        if (rejection) showToast(rejection, true);
        if (!quiet && receipt.state !== "completed") scheduleFocus(op.kind === "create" ? "create" : "heading");
        if (home || !currentId) void loadList();
        if (currentId) void loadCurrent(currentId, true);
        else if (selected.current) void loadDetail();
      } else setInspection(state => ({ ...state, [op.key]: receipt.state === "pending"
        ? "La solicitud sigue en curso. No la repetimos." : "Todavía no hay una recepción confirmada. Esto no demuestra que la solicitud no pueda llegar más tarde." }));
    } catch (cause) {
      if (owns(generation, controller) && receiptRequests.current.get(op.key) === controller)
        setInspection(state => ({ ...state, [op.key]: api.errorMessage(cause) }));
    } finally {
      if (receiptRequests.current.get(op.key) === controller) {
        receiptRequests.current.delete(op.key); if (mounted.current) setReading(keys => keys.filter(key => key !== op.key));
      }
    }
  };
  const mutate: TurnosMutation = async save => {
    if (mutation.current || disabled || !scopeReady || !scope.current || !sessionActive()) return false;
    const controller = new AbortController(), generation = owner.current;
    const dispatched: { current: Operation | null } = { current: null };
    mutation.current = controller;
    listRequest.current?.abort(); listRequest.current = null; detailRequest.current?.abort(); detailRequest.current = null;
    setPending(true); setError(""); setNotice(""); setToast(null);
    setList(state => ({ ...state, pending: false })); setDetail(state => ({ ...state, pending: false }));
    try {
      const saved = await api.withAppointmentOperation(crypto.randomUUID(), context => {
        if (blocked(context.kind, context.target)) throw new Error("Unresolved operation intent");
        const op = { ...context, businessId: scope.current!.businessId, identityId: scope.current!.identityId };
        storeOperations([...operationRef.current, op]); dispatched.current = op;
      }, () => save(controller.signal));
      if (!owns(generation, controller) || mutation.current !== controller) return false;
      installSaved(saved);
      if (dispatched.current) storeOperations(operationRef.current.filter(op => op.key !== dispatched.current!.key));
      setPending(false); mutation.current = null;
      void loadList(); void loadDetail(saved.id); return true;
    } catch (cause) {
      if (!owns(generation, controller) || mutation.current !== controller) return false;
      setError(dispatched.current ? cause instanceof ApiError ? api.errorMessage(cause) : unknownMessage
        : "No se envió la operación: no pudimos protegerla o hay una solicitud sin resolver para este turno.");
      setPending(false); mutation.current = null;
      // HTTP failure alone is not proof of rollback. A durable failed receipt is.
      if (dispatched.current && cause instanceof ApiError) await recover(dispatched.current, false, true);
      return false;
    } finally { if (mutation.current === controller) mutation.current = null; }
  };
  const locked = disabled || pending;
  const createLocked = locked || !scopeReady || blocked("create", null);
  const detailLocked = locked || !scopeReady || (detail.value ? blocked("change", detail.value.id) : false);
  const select = (id: string, trigger?: HTMLButtonElement) => {
    if (locked || mutation.current || !sessionActive()) return;
    revealDialog(trigger);
    detailRequest.current?.abort(); detailRequest.current = null; selected.current = id;
    setDetail(read(null)); setEditor(null); setNotice(""); setError(operationRef.current.length ? unknownMessage : "");
    if (freshnessRef.current.has(id)) void loadCurrent(id, true);
    else void loadDetail(id, true);
  };
  const open = (mode: "create" | "change", trigger?: HTMLButtonElement) => {
    // A client handoff may display the editor while scope/recovery locks still prevent writes.
    if ((trigger ? locked : mode === "create" ? createLocked : detailLocked) || mutation.current || !sessionActive()) return;
    revealDialog(trigger ?? (mode === "create" ? createButton.current ?? undefined : undefined));
    setError(operationRef.current.length ? unknownMessage : ""); setNotice(""); setEditor(mode); void loadCatalog();
  };
  const target = clientFlow?.target;
  useEffect(() => {
    if (!target) return;
    if ("appointmentId" in target) select(target.appointmentId, target.trigger);
    else open("create", target.trigger);
  }, [target]);
  const dismissClientFlow = () => {
    detailRequest.current?.abort(); detailRequest.current = null; selected.current = null;
    setDetail(read(null)); setEditor(null); setDialogVisible(false);
    clientFlow?.close();
  };
  const cancelEditor = () => {
    if (clientFlow && editor === "create") return dismissClientFlow();
    setEditor(null); setError(operationRef.current.length ? unknownMessage : "");
    if (editor === "create") setDialogVisible(false);
    scheduleFocus(editor === "create" ? "create" : "detail");
  };
  const outsideDismiss = useOutsideDismiss(() => closeDialog());
  const closeDialog = () => {
    // Hiding must never interrupt a write or resolve an operation intent.
    if (pending || mutation.current || dialog.current?.querySelector('[aria-busy="true"]')) return;
    if (clientFlow) return dismissClientFlow();
    if (editor && !(editor === "create" ? createLocked : detailLocked) && sessionActive()) cancelEditor();
    setDialogVisible(false);
  };
  const feedback = <div className="turnos-feedback">
    {notice && notice !== "Turno guardado" && <p role="status">{notice}</p>}
    {error && (!dialogVisible || !editor || catalog.pending || catalog.error) && <PanelInlineError message={error} />}
    {!scopeReady && !disabled && (!floating || error) && <button disabled={pending} onClick={() => void loadScope()}>Actualizar autorización</button>}
    {Object.entries(freshness).map(([id, state]) => <section className="turnos-recovery" key={id} aria-label="Estado actual del turno">
      {state === "failed"
        ? <PanelInlineError message="No pudimos verificar el estado actual del turno. La operación se guardó; los datos visibles pueden no estar actualizados. Solo este turno permanece protegido." />
        : <p role="status">Verificando el estado actual del turno. La recepción histórica no reemplaza los datos actuales.</p>}
      <button disabled={locked || state === "pending"} onClick={() => void loadCurrent(id, true)}>Actualizar estado actual</button>
    </section>)}
    {operations.map(op => <section className="turnos-recovery" key={op.key} aria-label="Recuperar solicitud de turno">
      <p>Solicitud {op.kind === "create" ? "de creación" : "de modificación"} sin resolver. Otros turnos siguen disponibles.</p>
      {inspection[op.key] && <p role="status">{inspection[op.key]}</p>}
      <button disabled={locked || reading.includes(op.key)} onClick={() => void recover(op)}>Consultar resultado guardado</button>
      {fence !== op.key ? <button disabled={locked || reading.includes(op.key)} onClick={() => setFence(op.key)}>Cancelar solicitud pendiente</button>
        : <><p>Esto impide que esta solicitud pendiente se ejecute más tarde. No cancela un turno ni revierte un cambio ya guardado.</p>
          <button disabled={locked || reading.includes(op.key)} onClick={() => void recover(op, true)}>Confirmar cancelación de solicitud</button>
          <button disabled={locked || reading.includes(op.key)} onClick={() => setFence(null)}>Volver sin cancelar solicitud</button></>}
    </section>)}
    </div>;
  const listError = list.error && (notice ? "El turno se guardó, pero no pudimos actualizar la lista." : list.error);
  const refreshAgenda = () => { void loadList(); void loadSchedule(); };
  const Surface = embedded ? "div" : "main";
  return <Surface className={floating ? "turnos-screen turnos-floating" : embedded ? "turnos-screen" : home ? "turnos-screen business-home-screen" : "turnos-screen agenda-screen"}
    aria-labelledby={embedded ? undefined : "turnos-title"}>
    {(!embedded || floating) && <button type="button" className="turnos-fab" ref={createButton}
      aria-disabled={createLocked} onClick={() => open("create")} aria-haspopup="dialog" aria-controls="turnos-dialog">
      <span className="turnos-fab__icon"><AgendaIcon name="plus" /></span><span>Nuevo turno</span>
    </button>}
    {floating && !dialogVisible && feedback}
    {!embedded && <><header className="turnos-heading"><h1 id="turnos-title" ref={heading} tabIndex={-1}>{home ? "Inicio" : "Agenda"}</h1></header>
    {home && !dialogVisible && feedback}
    {home ? <BusinessHome today={today} now={now} rows={list.value}
      pending={list.pending} stale={loadedHomeDate !== today}
      error={list.error && (notice ? "El turno se guardó, pero no pudimos actualizar la lista." : list.error)}
      locked={locked} select={select} refresh={() => void loadList()} /> : <>
      {!dialogVisible && <div className="ag-feedback">{feedback}</div>}
      {list.pending && <div className="ag-loading"><p role="status">Actualizando turnos…</p></div>}
      {(listError || schedule.error) && <div className="ag-feedback">
        {listError && <p role="alert">{listError}</p>}
        {schedule.error && <p role="alert">No pudimos consultar los horarios y recursos. {schedule.error}</p>}
        <button type="button" disabled={locked || list.pending || schedule.pending} onClick={refreshAgenda}>Actualizar turnos</button>
      </div>}
      <AgendaViewContent date={agendaDate} today={today} {...{ view, setDate, setView, resource, setResource, select, locked, listReady }}
        rows={list.value} schedule={schedule.error ? null : schedule.value}
        pending={list.pending || schedule.pending} availabilityReady={!schedule.pending} />
      {!listError && !schedule.error && <button type="button" className="ag-refresh" disabled={locked || list.pending || schedule.pending} onClick={refreshAgenda}>Actualizar turnos</button>}
    </>}</>}
    <dialog id="turnos-dialog" className="turnos-dialog" ref={dialog} aria-labelledby="turnos-dialog-title"
      {...outsideDismiss}
      onCancel={event => { event.preventDefault(); closeDialog(); }}>
    <header className="turnos-dialog__header">
      <div><h2 id="turnos-dialog-title" ref={dialogHeading} tabIndex={-1}>{editor === "create" ? "Nuevo turno" : editor === "change" ? "Modificar turno" : "Detalle del turno"}</h2>
        {editor && <p>{editor === "create" ? "Cliente, servicio y disponibilidad en una sola vista." : "Modificá el servicio, el recurso o el horario de la reserva."}</p>}
      </div>
      <button id="turnos-dialog-close" type="button" aria-label="Cerrar ventana de turno" disabled={pending} onClick={closeDialog}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </header>
    <div className="turnos-dialog__body">
    {dialogVisible && feedback}
    <div hidden={!!editor}>
    {detail.pending && <p role="status">Actualizando detalle…</p>}
    {detail.error && <div><PanelInlineError message={notice ? "El turno se guardó, pero no pudimos actualizar el detalle." : detail.error} />
      <button disabled={locked || detail.pending} onClick={() => void loadDetail()}>Actualizar detalle</button></div>}
    {detail.value && <TurnosDetail key={detail.value.id} row={detail.value} now={now} disabled={detailLocked} mutate={mutate} change={() => open("change")} />}
    </div>
    {editor && <section aria-label={editor === "create" ? "Nuevo turno" : "Modificar turno"}>
      {catalog.pending && <p role="status">Cargando servicios y recursos…</p>}
      {catalog.error && <div><PanelInlineError message={catalog.error} /><button disabled={locked} onClick={() => void loadCatalog()}>Actualizar catálogo</button></div>}
      {!catalog.pending && !catalog.error && <TurnosBookingForm key={`${editor}:${detail.value?.id ?? "new"}`}
        appointment={editor === "change" ? detail.value : null}
        initialClient={editor === "create" && target && "client" in target ? target.client : null}
        services={catalog.value.services} resources={catalog.value.resources}
        disabled={editor === "create" ? createLocked : detailLocked} sessionActive={sessionActive} now={now} mutate={mutate}
        error={error} onInvalid={message => showToast(message, true)} cancel={cancelEditor} />}
    </section>}
    </div>
    </dialog>
    {!disabled && toast && <PanelToast key={toast.revision} message={toast.message} error={toast.error}
      dialog={dialogVisible ? dialog.current : null} />}
  </Surface>;
}
