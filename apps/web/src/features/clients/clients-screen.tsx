"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Client, type ClientInput, type AppointmentRecord } from "../../api/api-client";
import { useOutsideDismiss } from "../../components/dialog-dismiss";
import { normalizeClientPhone } from "../../../../../packages/domain/src/clients";
import { formatArgentinaClosureInstant } from "../business-calendar/argentina-closure-time";
import { TurnosScreen, type ClientTurno } from "../appointments/turnos-screen";
import "./clients.css";

const icons = {
  search: "M21 21l-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  x: "m6 6 12 12M18 6 6 18",
  check: "m5 12 4 4L19 6",
  pencil: "m15 5 4 4M4 20l4-1L20 7a2.83 2.83 0 0 0-4-4L4 15z",
  calendar: "M3 5h18v16H3zM8 3v4m8-4v4M3 10h18m-13 5h3m-3 3h6",
  phone: "M22 16.9V20a2 2 0 0 1-2.2 2A20 20 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7l.6 2.8a2 2 0 0 1-.5 2.1L7.8 9.9a16 16 0 0 0 6.3 6.3l1.3-1.3a2 2 0 0 1 2.1-.5l2.8.6a2 2 0 0 1 1.7 1.9Z",
};

function Icon({ name }: { name: keyof typeof icons }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

function Avatar({ client }: { client: Client }) {
  const initials = client.name.trim().split(/\s+/, 2).map(word => Array.from(word)[0]).join("");
  return <span className="client-avatar" aria-hidden="true">{initials}</span>;
}

type ReadState<T> = { rows: T[]; pending: boolean; error: string };
const emptyRead = <T,>(): ReadState<T> => ({ rows: [], pending: false, error: "" });
const states: Record<AppointmentRecord["state"], string> = {
  confirmed: "Confirmado", cancelled: "Cancelado", done: "Completado", no_show: "Ausente",
};
const currency = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fields = [
  ["name", "Nombre completo", "name", "Nombre completo"],
  ["phone", "Teléfono", "tel", "+54 9 260 ..."],
] as const;

function Appointments({ title, rows, empty, pending = false, disabled, open }: {
  title: string; rows: AppointmentRecord[]; empty?: string; pending?: boolean; disabled: boolean;
  open: (appointmentId: string, trigger: HTMLButtonElement) => void;
}) {
  return <section className="client-history" aria-label={title} aria-busy={pending || undefined}>
    <h3>{title}</h3>
    {!rows.length ? !pending && <p className="client-history-empty">{empty ?? "No hay turnos en esta sección."}</p> : <ul aria-label={title}>
      {rows.map(row => <li key={row.id}><button className="client-history-row" type="button" disabled={disabled}
        aria-haspopup="dialog" onClick={event => open(row.id, event.currentTarget)}>
        <time dateTime={row.startsAt}>{formatArgentinaClosureInstant(row.startsAt)}</time>
        <strong>{row.terms.serviceName}</strong>
        <small>{row.terms.resourceName} · {row.terms.durationMinutes} min · {currency.format(row.terms.priceArs)}</small>
        <span>{states[row.state]}</span>
      </button></li>)}
    </ul>}
  </section>;
}

const uncertainMessage = "No pudimos confirmar si el cliente se guardó. Comprobá el cliente antes de continuar.";
const storageMessage = "No pudimos proteger el intento en este navegador. No enviaremos otro cliente.";

export function ClientsScreen({ disabled, sessionActive, businessId, identityId }: {
  disabled: boolean; sessionActive: () => boolean; businessId: string | null; identityId: string;
}) {
  // Local recovery evidence, not a backend receipt or a cross-device guarantee.
  const journalKey = businessId && identityId ? `agendia.client-create:${businessId}:${identityId}` : null;
  const fenced = useRef(true);
  const journalValue = useRef<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [storageError, setStorageError] = useState("");
  const clearJournal = () => {
    try {
      if (!journalKey || journalValue.current === null || localStorage.getItem(journalKey) !== journalValue.current)
        throw new Error("Journal ownership lost");
      localStorage.removeItem(journalKey);
      if (localStorage.getItem(journalKey) !== null) throw new Error("Journal retained");
      fenced.current = false;
      setUncertain(false);
      setStorageError("");
      return true;
    } catch {
      setStorageError(storageMessage);
      return false;
    }
  };
  const [list, setList] = useState<ReadState<Client>>(() => ({ ...emptyRead<Client>(), pending: true }));
  const [history, setHistory] = useState<ReadState<AppointmentRecord>>(emptyRead);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Client | null>(null);
  // Retain the booking controller on close so receipt recovery stays available on reopening.
  const [turno, setTurno] = useState<ClientTurno | null>();
  const [draft, setDraft] = useState<ClientInput | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  const owner = useRef(0);
  const selectedRef = useRef<Client | null>(null);
  const query = useRef("");
  const listRequest = useRef<AbortController | null>(null);
  const enterRequest = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const resume = useRef<HTMLButtonElement>(null);
  const [recoveryHidden, setRecoveryHidden] = useState(false);
  const panelOpen = (creating || selected !== null) && !recoveryHidden;
  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (panelOpen && !panel.open) panel.showModal();
    else if (!panelOpen && panel.open) {
      panel.close();
      resume.current?.focus();
    }
  }, [panelOpen]);
  const focusTarget = useRef<"name" | "save" | "edit" | "create" | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const scheduleFocus = (target: typeof focusTarget.current) => {
    focusTarget.current = target;
    setFocusRevision(value => value + 1);
  };
  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (!target || disabled || !sessionActive()) return;
    const element = target === "edit" ? editButton.current : target === "create" ? createButton.current
      : form.current?.querySelector<HTMLInputElement | HTMLButtonElement>(target === "name" ? '[name="name"]' : '[type="submit"]');
    if (element?.isConnected && !element.disabled) element.focus();
  }, [focusRevision]);

  const current = (generation: number, controller: AbortController) =>
    mounted.current && owner.current === generation && !controller.signal.aborted && sessionActive();
  const loadList = async (q = query.current) => {
    if (disabled || mutation.current || !sessionActive() || (listRequest.current && query.current === q)) return;
    enterRequest.current = null;
    listRequest.current?.abort();
    const controller = new AbortController(), generation = owner.current;
    const changed = q !== query.current;
    listRequest.current = controller;
    query.current = q;
    setList(state => ({ rows: changed ? [] : state.rows, pending: true, error: "" }));
    try {
      const rows = await api.clients(q, controller.signal);
      if (current(generation, controller) && listRequest.current === controller) {
        setList({ rows, pending: false, error: "" });
        if (enterRequest.current === controller && rows[0] && searchInput.current?.matches(":focus")) select(rows[0]);
      }
    } catch (cause) {
      if (current(generation, controller) && listRequest.current === controller)
        setList(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally {
      if (enterRequest.current === controller) enterRequest.current = null;
      if (listRequest.current === controller) listRequest.current = null;
    }
  };
  const loadHistory = async (client = selectedRef.current, replacePending = false) => {
    if (!mounted.current || disabled || !sessionActive() || !client || selectedRef.current?.id !== client.id || mutation.current) return;
    if (historyRequest.current && !replacePending) return;
    historyRequest.current?.abort();
    const controller = new AbortController(), generation = owner.current;
    historyRequest.current = controller;
    setHistory(state => ({ ...state, pending: true, error: "" }));
    try {
      const rows = await api.clientAppointments(client.id, controller.signal);
      if (current(generation, controller) && historyRequest.current === controller && selectedRef.current?.id === client.id)
        setHistory({ rows, pending: false, error: "" });
    } catch (cause) {
      if (current(generation, controller) && historyRequest.current === controller && selectedRef.current?.id === client.id)
        setHistory(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally {
      if (historyRequest.current === controller) historyRequest.current = null;
    }
  };
  useEffect(() => {
    mounted.current = true;
    fenced.current = true;
    try {
      if (!journalKey) throw new Error("Missing authenticated scope");
      const raw = localStorage.getItem(journalKey);
      if (raw !== null) {
        const entry = JSON.parse(raw);
        const draft = entry?.draft;
        if (typeof draft?.phone !== "string" || Object.keys(entry).length !== 2)
          throw new Error("Invalid journal");
        const keys = Object.keys(draft).length;
        const name = entry.version === 2 && keys === 2 && typeof draft.name === "string" ? draft.name
          : entry.version === 1 && keys === 3 && typeof draft.firstName === "string" && typeof draft.lastName === "string"
            ? `${draft.firstName} ${draft.lastName}`.replace(/\s+/g, " ").trim() : null;
        if (name === null) throw new Error("Invalid journal");
        // Read legacy drafts without changing the stored bytes used to prove ownership.
        journalValue.current = raw;
        setDraft({ name, phone: draft.phone });
        setCreating(true);
        setUncertain(true);
        setSaveError(uncertainMessage);
      } else fenced.current = false;
    } catch {
      setStorageError(storageMessage);
    }
    void loadList();
    const clock = () => setNow(Date.now());
    const timer = setInterval(clock, 30_000);
    window.addEventListener("focus", clock);
    document.addEventListener("visibilitychange", clock);
    return () => {
      mounted.current = false;
      owner.current++;
      enterRequest.current = null;
      const listController = listRequest.current;
      const historyController = historyRequest.current;
      const mutationController = mutation.current;
      listController?.abort();
      historyController?.abort();
      mutationController?.abort();
      if (listRequest.current === listController) listRequest.current = null;
      if (historyRequest.current === historyController) historyRequest.current = null;
      if (mutation.current === mutationController) mutation.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", clock);
      document.removeEventListener("visibilitychange", clock);
    };
  }, []);
  useEffect(() => {
    if (!disabled) return;
    owner.current++;
    enterRequest.current = null;
    listRequest.current?.abort();
    historyRequest.current?.abort();
    if (mutation.current) setSaveError(creating ? uncertainMessage
      : "No pudimos confirmar si el cliente se guardó. Actualizá los clientes antes de volver a guardar.");
    mutation.current?.abort();
    mutation.current = null;
    listRequest.current = null;
    historyRequest.current = null;
    setPending(false);
    setList(state => ({ ...state, pending: false, error: "La lectura se interrumpió. Actualizá los clientes." }));
    setHistory(state => ({ ...state, pending: false, error: selectedRef.current ? "La lectura se interrumpió. Actualizá los turnos." : "" }));
  }, [disabled]);
  const select = (client: Client | null) => {
    if (mutation.current || fenced.current || disabled || !sessionActive()) return;
    enterRequest.current = null;
    historyRequest.current?.abort();
    historyRequest.current = null;
    selectedRef.current = client;
    setSelected(client);
    setCreating(false);
    setDraft(null);
    setSaveError("");
    setNotice("");
    setHistory(emptyRead());
    if (client) void loadHistory(client);
  };
  const searchClients = (q: string) => {
    if (mutation.current || fenced.current || disabled || !sessionActive()) return;
    select(null); // Search owns the list; a former selection cannot keep hidden detail alive.
    void loadList(q);
  };
  const startCreate = () => {
    if (mutation.current || fenced.current || disabled || !sessionActive()) return;
    select(null);
    setCreating(true);
    setDraft({ name: "", phone: "" });
    scheduleFocus("name");
  };
  const cancelCreate = () => {
    if (mutation.current || fenced.current || disabled || !sessionActive()) return;
    setCreating(false);
    setDraft(null);
    setSaveError("");
    scheduleFocus("create");
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const client = selectedRef.current;
    if ((!client && !creating) || !draft || mutation.current || fenced.current || disabled || !sessionActive()) return;
    if (creating) {
      fenced.current = true;
      setUncertain(true);
      try {
        if (!journalKey || localStorage.getItem(journalKey) !== null) throw new Error("Journal unavailable");
        journalValue.current = JSON.stringify({ version: 2, draft });
        localStorage.setItem(journalKey, journalValue.current);
        if (localStorage.getItem(journalKey) !== journalValue.current) throw new Error("Journal not durable");
      } catch {
        setStorageError(storageMessage);
        return; // A POST is forbidden without durable local evidence.
      }
    }
    const controller = new AbortController(), generation = owner.current;
    mutation.current = controller;
    listRequest.current?.abort();
    historyRequest.current?.abort();
    setPending(true);
    setList(state => ({ ...state, pending: false }));
    setHistory(state => ({ ...state, pending: false }));
    setSaveError("");
    setNotice("");
    const owns = () => current(generation, controller) && mutation.current === controller && selectedRef.current?.id === client?.id;
    try {
      const saved = creating ? await api.createClient(draft, controller.signal)
        : await api.updateClient(client!.id, draft, controller.signal);
      if (!owns()) return;
      if (creating && !clearJournal()) {
        setPending(false);
        return;
      }
      // The confirmed DTO is authoritative even if either subsequent GET fails.
      selectedRef.current = saved;
      setSelected(saved);
      setList(state => ({ ...state, rows: creating ? [saved, ...state.rows.filter(row => row.id !== saved.id)]
        : state.rows.map(row => row.id === saved.id ? saved : row), pending: false }));
      setHistory(state => ({ ...state, rows: creating ? [] : state.rows.map(row => ({ ...row, client: saved })), pending: false }));
      if (creating) {
        setSearch("");
        query.current = "";
      }
      setCreating(false);
      setDraft(null);
      setNotice("Cliente guardado");
      mutation.current = null;
      listRequest.current = null;
      historyRequest.current = null;
      setPending(false);
      scheduleFocus("edit");
      // Independent GET recovery cannot fall through the mutation failure branch.
      void loadList();
      void loadHistory(saved);
    } catch (cause) {
      if (!owns()) return;
      const rejected = cause instanceof ApiError && [400, 401, 403, 404, 409].includes(cause.status);
      if (creating && (!rejected || !clearJournal())) setSaveError(uncertainMessage);
      else setSaveError(cause instanceof ApiError ? api.errorMessage(cause)
        : "No pudimos confirmar si el cliente se guardó. Actualizá los clientes antes de volver a guardar.");
      setPending(false);
      scheduleFocus("save");
    } finally {
      if (mutation.current === controller) mutation.current = null;
    }
  };
  const checkClient = async () => {
    if (!uncertain || !draft || mutation.current || disabled || !sessionActive()) return;
    listRequest.current?.abort();
    listRequest.current = null;
    historyRequest.current?.abort();
    historyRequest.current = null;
    const controller = new AbortController(), generation = owner.current;
    mutation.current = controller;
    setPending(true);
    setSaveError("");
    const owns = () => current(generation, controller) && mutation.current === controller;
    try {
      const rows = await api.clients("", controller.signal);
      if (!owns()) return;
      const phone = normalizeClientPhone(draft.phone);
      const matches = rows.filter(row => phone && row.phone === phone &&
        row.name === draft.name.trim());
      if (matches.length !== 1) {
        setSaveError(uncertainMessage); // Absence or mismatched names never proves rollback.
        return;
      }
      if (!clearJournal()) return;
      const saved = matches[0]!;
      selectedRef.current = saved;
      setSelected(saved);
      setList({ rows, pending: false, error: "" });
      setHistory(emptyRead());
      setCreating(false);
      setDraft(null);
      setSearch("");
      query.current = "";
      setNotice("Este cliente existe");
      setPending(false);
      mutation.current = null;
      historyRequest.current = null;
      scheduleFocus("edit");
      void loadHistory(saved);
    } catch (cause) {
      if (owns()) setSaveError(api.errorMessage(cause));
    } finally {
      if (owns()) setPending(false);
      if (mutation.current === controller) mutation.current = null;
    }
  };
  const locked = disabled || pending || fenced.current || !!storageError;
  const openTurno = (target: ClientTurno) => {
    if (!locked && !mutation.current && sessionActive()) setTurno(target);
  };
  const historyAction = { disabled: locked, open: (appointmentId: string, trigger: HTMLButtonElement) => openTurno({ appointmentId, trigger }) };
  const canDismiss = !disabled && !pending && (!locked || (creating && uncertain));
  const closePanel = () => {
    if (!canDismiss || mutation.current || !sessionActive()) return;
    if (locked) setRecoveryHidden(true); // Keep the journal and fence; the shell stays reachable.
    else if (creating) cancelCreate();
    else select(null);
  };
  const backdrop = useOutsideDismiss(closePanel);
  const listWarning = list.error && <div className="client-warning">
    <p role="alert">{notice ? "El cliente se guardó, pero no pudimos actualizar la lista." : list.error}</p>
    <button className="client-button" disabled={locked || list.pending} onClick={() => void loadList()}>Actualizar clientes</button>
  </div>;
  return <><main className="client-directory-page" aria-labelledby="clients-title">
    <h1 id="clients-title" className="client-sr-only">Clientes</h1>
    {!panelOpen && storageError && <p role="alert">{storageError}</p>}
    <section className="client-directory" aria-label="Directorio de clientes" aria-busy={list.pending || undefined}>
        <div className="clients-heading">
          <form className="client-search" aria-label="Buscar clientes" onSubmit={event => {
            event.preventDefault();
            searchClients(search.trim());
          }}>
            <input ref={searchInput} aria-label="Nombre o teléfono" placeholder="Buscar nombre o teléfono" value={search} disabled={locked}
              onBlur={() => { enterRequest.current = null; }} onChange={event => {
                if (locked || mutation.current || !sessionActive()) return;
                const value = event.target.value, q = value.trim();
                enterRequest.current = null;
                setSearch(value);
                if (q !== query.current) searchClients(q);
              }} onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") enterRequest.current = null;
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (locked || mutation.current || !sessionActive()) return;
                if (listRequest.current) enterRequest.current = listRequest.current;
                else if (!list.pending && !list.error && list.rows[0]) select(list.rows[0]);
              }} />
            <button aria-label="Buscar" disabled={locked} type="submit"><Icon name="search" /></button>
          </form>
          <button className="client-new" ref={createButton} disabled={locked || creating} onClick={startCreate}><Icon name="plus" />Nuevo cliente</button>
        </div>
        {recoveryHidden && <div className="client-warning">
          <p role="alert">{saveError || storageError || uncertainMessage}</p>
          <button className="client-button" ref={resume} disabled={disabled} onClick={() => setRecoveryHidden(false)}>Volver a la comprobación</button>
        </div>}
        {!panelOpen && listWarning}
        {!list.pending && !list.error && !list.rows.length && <div className="client-empty"><strong>Sin resultados</strong>
          <p>{query.current ? "No hay clientes que coincidan." : "Todavía no hay clientes."}</p></div>}
        <ul className="client-rows" aria-label="Clientes del negocio">
          {list.rows.map(client => <li key={client.id}>
            <button className="client-row" disabled={locked} aria-pressed={selected?.id === client.id} onClick={() => select(client)}>
              <Avatar client={client} /><span className="client-row-copy"><strong>{client.name}</strong><small className="client-number">{client.phone}</small></span>
              <span className="client-row-arrow"><Icon name="arrow" /></span>
            </button>
          </li>)}
        </ul>
    </section>
    <dialog className="client-dialog" ref={dialog} aria-labelledby="client-panel-title" {...backdrop}
      onCancel={event => { event.preventDefault(); closePanel(); }}>
      {panelOpen && <div className="client-panel" role={selected ? "region" : undefined} aria-label={selected ? "Cliente seleccionado" : undefined}>
        <header className="client-panel-head">
          <span><Icon name="users" /></span>
          <h2 id="client-panel-title">{creating ? "Nuevo cliente" : draft ? "Editar cliente" : "Cliente"}</h2>
          <button className="client-close" type="button" autoFocus={!draft} aria-label="Cerrar panel" disabled={!canDismiss} onClick={closePanel}><Icon name="x" /></button>
        </header>
        {draft ? <form ref={form} aria-label={creating ? "Crear cliente" : "Editar cliente"} aria-busy={pending} onSubmit={save}>
          <div className="client-panel-body">
            {fields.map(([key, label, autoComplete, placeholder]) => <div className="client-field" key={key}>
              <label htmlFor={`client-${key}`}>{label}</label>
              <input id={`client-${key}`} autoComplete={autoComplete} placeholder={placeholder} name={key}
                type={key === "phone" ? "tel" : "text"} required disabled={locked} value={draft[key]} onChange={event => {
                  if (!fenced.current && !mutation.current && !disabled && sessionActive()) setDraft({ ...draft, [key]: event.target.value });
                }} />
              {key === "phone" && <small>Se utiliza para identificar al cliente y evitar contactos duplicados.</small>}
            </div>)}
            {storageError && <p role="alert">{storageError}</p>}
            {saveError && <p role="alert">{saveError}</p>}
            {listWarning}
          </div>
          <footer className="client-panel-actions">
            <button className="client-button" disabled={locked} type="button" onClick={() => {
              if (creating) return cancelCreate();
              if (mutation.current || fenced.current || disabled || !sessionActive()) return;
              setDraft(null); setSaveError(""); scheduleFocus("edit");
            }}>Cancelar</button>
            <button className="client-button client-button-primary" disabled={locked} type="submit"><Icon name="check" />{pending ? "Guardando…" : "Guardar cliente"}</button>
            {uncertain && <button className="client-button client-button-primary" disabled={disabled || pending} type="button" onClick={() => void checkClient()}>Comprobar cliente</button>}
          </footer>
        </form> : selected && <>
          <div className="client-panel-body client-record">
            <div className="client-identity"><Avatar client={selected} /><h2>{selected.name}</h2></div>
            <div className="client-phone"><Icon name="phone" /><span><strong>Teléfono</strong><br /><span className="client-number">{selected.phone}</span></span></div>
            {notice && <p role="status">{notice}</p>}
            {listWarning}
            {history.error && <div className="client-warning">
              <p role="alert">{notice ? "El cliente se guardó, pero no pudimos actualizar los turnos." : history.error}</p>
              <button className="client-button" disabled={locked || history.pending} onClick={() => void loadHistory()}>Actualizar turnos</button>
            </div>}
            {history.rows.length > 0 && <Appointments {...historyAction} title="Próximos turnos" pending={history.pending}
              rows={history.rows.filter(row => row.state === "confirmed" && row.startMs > now)} />}
            {(history.rows.length > 0 || !history.error) && <Appointments {...historyAction} title="Historial completo" rows={history.rows}
              pending={history.pending} empty="Este cliente todavía no tiene turnos registrados." />}
          </div>
          <footer className="client-panel-actions client-record-actions">
            <button className="client-button" disabled={locked} onClick={closePanel}>Cerrar</button>
            <button className="client-button" ref={editButton} aria-label="Editar cliente" disabled={locked} onClick={() => {
              if (mutation.current || fenced.current || disabled || !sessionActive()) return;
              setDraft({ name: selected.name, phone: selected.phone });
              setSaveError(""); scheduleFocus("name");
            }}><Icon name="pencil" />Editar</button>
            <button className="client-button client-button-primary" type="button" disabled={locked} aria-haspopup="dialog"
              onClick={event => openTurno({ client: selected, trigger: event.currentTarget })}>
              <Icon name="calendar" /><span>Nuevo turno</span>
            </button>
          </footer>
        </>}
      </div>}
    </dialog>
  </main>{turno !== undefined && <TurnosScreen disabled={disabled} sessionActive={sessionActive}
    clientFlow={{ target: turno, close: () => {
      setTurno(null);
      // A history read started before the booking may not include it.
      void loadHistory(selectedRef.current, true);
    } }} />}</>;
}
