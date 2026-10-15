"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppointmentRecord, type AppointmentOperationContext, type AppointmentOperationReceipt, type Service, type Resource } from "../api-client";
import { TurnosBookingForm } from "./turnos-booking-form";
import { TurnosDetail } from "./turnos-detail";
import { addDays, argentinaDate, calendarRows, dateLabel, dayBounds, monthDays, shiftMonth, turnoStates, turnoTime } from "./turnos-calendar";

export type TurnosMutation = (save: (signal: AbortSignal) => Promise<AppointmentRecord>) => Promise<boolean>;
type Read<T> = { value: T; pending: boolean; error: string };
type Operation = AppointmentOperationContext & { businessId: string; identityId: string };
const read = <T,>(value: T): Read<T> => ({ value, pending: false, error: "" });
const unknownMessage = "No pudimos confirmar el resultado. El turno podría haberse guardado. Consultá el resultado guardado; no repetimos la operación.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function TurnosScreen({ disabled, sessionActive }: { disabled: boolean; sessionActive: () => boolean }) {
  const [view, setView] = useState<"today" | "week" | "month">("today");
  const [anchor, setAnchor] = useState(argentinaDate), [day, setDay] = useState(argentinaDate);
  const [list, setList] = useState(() => read<AppointmentRecord[]>([]));
  const [detail, setDetail] = useState(() => read<AppointmentRecord | null>(null));
  const [catalog, setCatalog] = useState(() => read<{ services: Service[]; resources: Resource[] }>({ services: [], resources: [] }));
  const [editor, setEditor] = useState<"create" | "change" | null>(null);
  const [pending, setPending] = useState(false), [scopeReady, setScopeReady] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
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
  const receiptRequests = useRef(new Map<string, AbortController>());
  const selected = useRef<string | null>(null), range = useRef({ from: "", to: "" });
  const heading = useRef<HTMLHeadingElement>(null), createButton = useRef<HTMLButtonElement>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const focus = useRef<"create" | "detail" | "heading" | null>(null);
  const scheduleFocus = (target: typeof focus.current) => { focus.current = target; setFocusRevision(value => value + 1); };
  useEffect(() => {
    const target = focus.current; focus.current = null;
    if (disabled || !sessionActive()) return;
    const element = target === "create" ? createButton.current
      : target === "detail" ? document.getElementById("turnos-detail-title") : heading.current;
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
    if (mutation.current || listRequest.current || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current, bounds = range.current, revision = projectionRevision.current;
    listRequest.current = controller; setList(state => ({ ...state, pending: true, error: "" }));
    try {
      const rows = await api.appointments(bounds, controller.signal);
      if (owns(generation, controller) && listRequest.current === controller && range.current === bounds) {
        if (projectionRevision.current === revision) setList(state => read([
          ...rows.filter(row => !freshnessRef.current.has(row.id)),
          ...state.value.filter(row => freshnessRef.current.has(row.id)),
        ]));
        else setList(state => ({ ...state, pending: false }));
      }
    } catch (cause) {
      if (owns(generation, controller) && listRequest.current === controller)
        setList(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally { if (listRequest.current === controller) listRequest.current = null; }
  };
  const loadDetail = async (id = selected.current, focusDetail = false) => {
    if (!id || mutation.current || detailRequest.current || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    detailRequest.current = controller; setDetail(state => ({ ...state, pending: true, error: "" }));
    try {
      const row = await api.appointment(id, controller.signal);
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
  const abortOwned = () => {
    for (const ref of [scopeRequest, listRequest, detailRequest, catalogRequest, mutation]) {
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
    owner.current++; abortOwned(); setScopeReady(false); setPending(false); setReading([]);
    setFreshness(state => Object.fromEntries(Object.keys(state).map(id => [id, "failed" as const])));
    setList(state => ({ ...state, pending: false, error: "Lectura interrumpida. Actualizá los turnos." }));
    setDetail(state => ({ ...state, pending: false, error: selected.current ? "Lectura interrumpida. Actualizá el detalle." : "" }));
    setCatalog(state => ({ ...state, pending: false }));
  }, [disabled]);
  const today = argentinaDate(now);
  const first = view === "today" ? today : view === "week" ? anchor : `${anchor.slice(0, 7)}-01`;
  const last = view === "week" ? addDays(first, 6) : view === "month" ? addDays(shiftMonth(first, 1), -1) : first;
  useEffect(() => {
    listRequest.current?.abort(); listRequest.current = null;
    range.current = { from: dayBounds(first).from, to: dayBounds(last).to }; void loadList();
  }, [first, last]);
  const installSaved = (saved: AppointmentRecord, show = true) => {
    setList(state => ({ ...state, value: [...state.value.filter(row => row.id !== saved.id), saved], pending: false }));
    if (show) { selected.current = saved.id; setDetail(read(saved)); setEditor(null); scheduleFocus("detail"); }
    setNotice("Turno guardado");
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
      setNotice("Turno guardado");
      setFreshness(state => { const next = { ...state }; delete next[id]; return next; });
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
        setError(receipt.state === "failed" ? api.errorMessage(new ApiError(receipt.error!.code, receipt.error!.message, receipt.httpStatus!)) : "");
        if (!quiet && receipt.state !== "completed") scheduleFocus(op.kind === "create" ? "create" : "heading");
        void loadList();
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
    setPending(true); setError(""); setNotice("");
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
  const select = (id: string) => {
    if (locked || mutation.current || !sessionActive()) return;
    detailRequest.current?.abort(); detailRequest.current = null; selected.current = id;
    setDetail(read(null)); setEditor(null); setNotice(""); setError(operationRef.current.length ? unknownMessage : "");
    if (freshnessRef.current.has(id)) void loadCurrent(id, true);
    else void loadDetail(id, true);
  };
  const open = (mode: "create" | "change") => {
    if ((mode === "create" ? createLocked : detailLocked) || mutation.current || !sessionActive()) return;
    setError(operationRef.current.length ? unknownMessage : ""); setNotice(""); setEditor(mode); void loadCatalog();
  };
  const days = view === "month" ? monthDays(anchor) : view === "week" ? Array.from({ length: 7 }, (_, index) => addDays(first, index)) : [today];
  const renderRows = (date: string) => {
    const rows = calendarRows(list.value, date);
    return <section key={date} aria-label={dateLabel(date)}><h2>{dateLabel(date)}</h2>
      {!rows.length ? <p>No hay turnos para esta fecha.</p> : <ul className="turnos-list" aria-label={`Turnos ${date}`}>
        {rows.map(row => <li key={row.id}><button disabled={locked} onClick={() => select(row.id)} aria-pressed={selected.current === row.id}>
          <time dateTime={row.startsAt}>{turnoTime(row.startMs)}</time>
          <span><strong>{row.client.firstName} {row.client.lastName}</strong><span>{row.terms.serviceName}</span></span><span>{turnoStates[row.state]}</span>
        </button></li>)}
      </ul>}
    </section>;
  };
  return <main className="turnos-screen" aria-labelledby="turnos-title">
    <div className="turnos-toolbar"><h1 id="turnos-title" ref={heading} tabIndex={-1}>Turnos</h1>
      <button ref={createButton} disabled={createLocked} onClick={() => open("create")}>Nuevo turno</button></div>
    <div className="turnos-toolbar" role="group" aria-label="Vista de turnos">
      {([ ["today", "Hoy"], ["week", "Semana"], ["month", "Mes"] ] as const).map(([value, label]) =>
        <button key={value} disabled={locked} aria-pressed={view === value} onClick={() => { setView(value); setAnchor(today); setDay(today); }}>{label}</button>)}
    </div>
    {view !== "today" && <div className="turnos-toolbar" role="group" aria-label="Navegar calendario">
      <button disabled={locked} onClick={() => { const next = view === "week" ? addDays(anchor, -7) : shiftMonth(anchor, -1); setAnchor(next); setDay(next); }}>Anterior</button>
      <button disabled={locked} onClick={() => { setAnchor(today); setDay(today); }}>Volver a hoy</button>
      <button disabled={locked} onClick={() => { const next = view === "week" ? addDays(anchor, 7) : shiftMonth(anchor, 1); setAnchor(next); setDay(next); }}>Siguiente</button>
    </div>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {!scopeReady && !disabled && <button disabled={pending} onClick={() => void loadScope()}>Actualizar autorización</button>}
    {Object.entries(freshness).map(([id, state]) => <section key={id} aria-label="Estado actual del turno">
      <p role={state === "failed" ? "alert" : "status"}>{state === "failed"
        ? "No pudimos verificar el estado actual del turno. La operación se guardó; los datos visibles pueden no estar actualizados. Solo este turno permanece protegido."
        : "Verificando el estado actual del turno. La recepción histórica no reemplaza los datos actuales."}</p>
      <button disabled={locked || state === "pending"} onClick={() => void loadCurrent(id, true)}>Actualizar estado actual</button>
    </section>)}
    {operations.map(op => <section key={op.key} aria-label="Recuperar solicitud de turno">
      <p>Solicitud {op.kind === "create" ? "de creación" : "de modificación"} sin resolver. Otros turnos siguen disponibles.</p>
      {inspection[op.key] && <p role="status">{inspection[op.key]}</p>}
      <button disabled={locked || reading.includes(op.key)} onClick={() => void recover(op)}>Consultar resultado guardado</button>
      {fence !== op.key ? <button disabled={locked || reading.includes(op.key)} onClick={() => setFence(op.key)}>Cancelar solicitud pendiente</button>
        : <><p>Esto impide que esta solicitud pendiente se ejecute más tarde. No cancela un turno ni revierte un cambio ya guardado.</p>
          <button disabled={locked || reading.includes(op.key)} onClick={() => void recover(op, true)}>Confirmar cancelación de solicitud</button>
          <button disabled={locked || reading.includes(op.key)} onClick={() => setFence(null)}>Volver sin cancelar solicitud</button></>}
    </section>)}
    {list.pending && <p role="status">Actualizando turnos…</p>}
    {list.error && <p role="alert">{notice ? "El turno se guardó, pero no pudimos actualizar la lista." : list.error}</p>}
    <button disabled={locked || list.pending} onClick={() => void loadList()}>Actualizar turnos</button>
    {view === "month" && <div className="turnos-month" role="group" aria-label="Días del mes">{days.map(date =>
      <button key={date} disabled={locked} aria-pressed={day === date} onClick={() => setDay(date)}>
        <span>{Number(date.slice(-2))}</span><span>{calendarRows(list.value, date).length} turnos</span>
      </button>)}</div>}
    {view === "month" ? renderRows(day) : days.map(renderRows)}
    {detail.pending && <p role="status">Actualizando detalle…</p>}
    {detail.error && <div><p role="alert">{notice ? "El turno se guardó, pero no pudimos actualizar el detalle." : detail.error}</p>
      <button disabled={locked || detail.pending} onClick={() => void loadDetail()}>Actualizar detalle</button></div>}
    {detail.value && <TurnosDetail key={detail.value.id} row={detail.value} now={now} disabled={detailLocked} mutate={mutate} change={() => open("change")} error={error} />}
    {editor && <section className="turnos-editor" aria-label={editor === "create" ? "Nuevo turno" : "Modificar turno"}>
      <h2>{editor === "create" ? "Nuevo turno" : "Modificar turno"}</h2>
      {catalog.pending && <p role="status">Cargando servicios y recursos…</p>}
      {catalog.error && <div><p role="alert">{catalog.error}</p><button disabled={locked} onClick={() => void loadCatalog()}>Actualizar catálogo</button></div>}
      {!catalog.pending && !catalog.error && <TurnosBookingForm key={`${editor}:${detail.value?.id ?? "new"}`}
        appointment={editor === "change" ? detail.value : null} services={catalog.value.services} resources={catalog.value.resources}
        disabled={editor === "create" ? createLocked : detailLocked} sessionActive={sessionActive} now={now} mutate={mutate}
        error={error} cancel={() => { setEditor(null); setError(operationRef.current.length ? unknownMessage : ""); scheduleFocus(editor === "create" ? "create" : "detail"); }} />}
    </section>}
  </main>;
}
