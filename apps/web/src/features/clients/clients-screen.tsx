"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Client, type ClientInput, type AppointmentRecord } from "../../api/api-client";
import { normalizeClientPhone } from "../../../../../packages/domain/src/clients";
import { formatArgentinaClosureInstant } from "../business-calendar/argentina-closure-time";

type ReadState<T> = { rows: T[]; pending: boolean; error: string };
const emptyRead = <T,>(): ReadState<T> => ({ rows: [], pending: false, error: "" });
const states: Record<AppointmentRecord["state"], string> = {
  confirmed: "Confirmado", cancelled: "Cancelado", done: "Completado", no_show: "Ausente",
};

function Appointments({ title, rows }: { title: string; rows: AppointmentRecord[] }) {
  return <section aria-label={title}>
    <h3>{title}</h3>
    {!rows.length ? <p>No hay turnos en esta sección.</p> : <ul className="clients-appointments" aria-label={title}>
      {rows.map(row => <li key={row.id}>
        <strong>{row.terms.serviceName}</strong>
        <p>{row.terms.resourceName} · {states[row.state]}</p>
        <p>{formatArgentinaClosureInstant(row.startsAt)}</p>
        <p>{row.terms.durationMinutes} min · {new Intl.NumberFormat("es-AR", {
          style: "currency", currency: "ARS",
        }).format(row.terms.priceArs)}</p>
      </li>)}
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
  const [list, setList] = useState<ReadState<Client>>(emptyRead);
  const [history, setHistory] = useState<ReadState<AppointmentRecord>>(emptyRead);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Client | null>(null);
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
  const historyRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const form = useRef<HTMLFormElement>(null);
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
    if (disabled || !sessionActive()) return;
    const element = target === "edit" ? editButton.current : target === "create" ? createButton.current
      : form.current?.querySelector<HTMLInputElement | HTMLButtonElement>(target === "name" ? '[name="firstName"]' : '[type="submit"]');
    if (element?.isConnected && !element.disabled) element.focus();
  }, [focusRevision]);

  const current = (generation: number, controller: AbortController) =>
    mounted.current && owner.current === generation && !controller.signal.aborted && sessionActive();
  const loadList = async (q = query.current) => {
    if (mutation.current || !sessionActive() || (listRequest.current && query.current === q)) return;
    listRequest.current?.abort();
    const controller = new AbortController(), generation = owner.current;
    listRequest.current = controller;
    query.current = q;
    setList(state => ({ ...state, pending: true, error: "" }));
    try {
      const rows = await api.clients(q, controller.signal);
      if (current(generation, controller) && listRequest.current === controller)
        setList({ rows, pending: false, error: "" });
    } catch (cause) {
      if (current(generation, controller) && listRequest.current === controller)
        setList(state => ({ ...state, pending: false, error: api.errorMessage(cause) }));
    } finally {
      if (listRequest.current === controller) listRequest.current = null;
    }
  };
  const loadHistory = async (client = selectedRef.current) => {
    if (!client || mutation.current || historyRequest.current || !sessionActive()) return;
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
        if (entry?.version !== 1 || !entry.draft || Object.keys(entry).length !== 2 ||
            Object.keys(entry.draft).length !== 3 ||
            !["firstName", "lastName", "phone"].every(key => typeof entry.draft[key] === "string"))
          throw new Error("Invalid journal");
        journalValue.current = raw;
        setDraft(entry.draft);
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
  const searchClients = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.current || fenced.current || disabled || !sessionActive()) return;
    select(null); // Search owns the list; a former selection cannot keep hidden detail alive.
    void loadList(search.trim());
  };
  const startCreate = () => {
    if (mutation.current || fenced.current || disabled || !sessionActive()) return;
    select(null);
    setCreating(true);
    setDraft({ firstName: "", lastName: "", phone: "" });
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
        journalValue.current = JSON.stringify({ version: 1, draft });
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
        row.firstName === draft.firstName.trim() && row.lastName === draft.lastName.trim());
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
  return <main className="clients-screen" aria-labelledby="clients-title">
    <h1 id="clients-title">Clientes</h1>
    <p>Buscá por nombre o teléfono. Los turnos conservan las condiciones originales del servicio y recurso.</p>
    {storageError && <p role="alert">{storageError}</p>}
    <button ref={createButton} disabled={locked || creating} onClick={startCreate}>Crear cliente</button>
    {creating && draft && <form ref={form} aria-label="Crear cliente" aria-busy={pending} onSubmit={save}>
      {([ ["firstName", "Nombre"], ["lastName", "Apellido"], ["phone", "Teléfono"] ] as const).map(([key, label]) =>
        <label key={key} htmlFor={`create-client-${key}`}>{label}
          <input id={`create-client-${key}`} name={key} type={key === "phone" ? "tel" : "text"} required disabled={locked}
            value={draft[key]} onChange={event => {
              if (!fenced.current && !mutation.current && !disabled && sessionActive()) setDraft({ ...draft, [key]: event.target.value });
            }} />
        </label>)}
      {saveError && <p role="alert">{saveError}</p>}
      <button disabled={locked} type="submit">{pending ? "Guardando…" : "Crear cliente"}</button>
      <button disabled={locked} type="button" onClick={cancelCreate}>Cancelar</button>
      {uncertain && <button disabled={disabled || pending} type="button" onClick={() => void checkClient()}>Comprobar cliente</button>}
    </form>}
    <form aria-label="Buscar clientes" onSubmit={searchClients}>
      <label htmlFor="clients-search">Nombre o teléfono</label>
      <input id="clients-search" value={search} disabled={locked} onChange={event => {
        if (!fenced.current && !mutation.current && !disabled && sessionActive()) setSearch(event.target.value);
      }} />
      <button disabled={locked} type="submit">Buscar</button>
    </form>
    {list.pending && <p role="status">Cargando clientes…</p>}
    {list.error && <div className="clients-warning"><p role="alert">{notice ? "El cliente se guardó, pero no pudimos actualizar la lista." : list.error}</p>
      <button disabled={locked || list.pending} onClick={() => void loadList()}>Actualizar clientes</button></div>}
    {!list.pending && !list.error && !list.rows.length && <p>{query.current ? "No hay clientes que coincidan." : "Todavía no hay clientes."}</p>}
    <ul className="clients-list" aria-label="Clientes del negocio">
      {list.rows.map(client => <li key={client.id}>
        <button disabled={locked} aria-pressed={selected?.id === client.id} onClick={() => select(client)}>
          <strong>{client.firstName} {client.lastName}</strong><span>{client.phone}</span>
        </button>
      </li>)}
    </ul>
    {selected && <section className="clients-detail" aria-label="Cliente seleccionado">
      <h2>{selected.firstName} {selected.lastName}</h2><p>{selected.phone}</p>
      {notice && <p role="status">{notice}</p>}
      {!draft ? <button ref={editButton} disabled={locked} onClick={() => {
        if (mutation.current || fenced.current || disabled || !sessionActive()) return;
        setDraft({ firstName: selected.firstName, lastName: selected.lastName, phone: selected.phone });
        setSaveError(""); scheduleFocus("name");
      }}>Editar cliente</button> : <form ref={form} aria-label="Editar cliente" aria-busy={pending} onSubmit={save}>
        {([ ["firstName", "Nombre"], ["lastName", "Apellido"], ["phone", "Teléfono"] ] as const).map(([key, label]) =>
          <label key={key} htmlFor={`client-${key}`}>{label}
            <input id={`client-${key}`} name={key} type={key === "phone" ? "tel" : "text"} required disabled={locked}
              value={draft[key]} onChange={event => {
                if (!fenced.current && !mutation.current && !disabled && sessionActive()) setDraft({ ...draft, [key]: event.target.value });
              }} />
          </label>)}
        {saveError && <p role="alert">{saveError}</p>}
        <button disabled={locked} type="submit">{pending ? "Guardando…" : "Guardar cambios"}</button>
        <button disabled={locked} type="button" onClick={() => {
          if (mutation.current || fenced.current || disabled || !sessionActive()) return;
          setDraft(null); setSaveError(""); scheduleFocus("edit");
        }}>Cancelar</button>
      </form>}
      {history.pending && <p role="status">Cargando turnos…</p>}
      {history.error && <div className="clients-warning"><p role="alert">{notice ? "El cliente se guardó, pero no pudimos actualizar los turnos." : history.error}</p>
        <button disabled={locked || history.pending} onClick={() => void loadHistory()}>Actualizar turnos</button></div>}
      <Appointments title="Próximos turnos" rows={history.rows.filter(row => row.state === "confirmed" && row.startMs > now)} />
      <Appointments title="Historial completo" rows={history.rows} />
    </section>}
  </main>;
}
