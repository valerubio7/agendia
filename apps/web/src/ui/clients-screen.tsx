"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Client, type ClientInput, type AppointmentRecord } from "../api-client";
import { formatArgentinaClosureInstant } from "./argentina-closure-time";

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

export function ClientsScreen({ disabled, sessionActive }: {
  disabled: boolean; sessionActive: () => boolean;
}) {
  const [list, setList] = useState<ReadState<Client>>(emptyRead);
  const [history, setHistory] = useState<ReadState<AppointmentRecord>>(emptyRead);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Client | null>(null);
  const [draft, setDraft] = useState<ClientInput | null>(null);
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
  const focusTarget = useRef<"name" | "save" | "edit" | null>(null);
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
    const element = target === "edit" ? editButton.current
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
    mutation.current?.abort();
    mutation.current = null;
    listRequest.current = null;
    historyRequest.current = null;
    setPending(false);
    setList(state => ({ ...state, pending: false, error: "La lectura se interrumpió. Actualizá los clientes." }));
    setHistory(state => ({ ...state, pending: false, error: selectedRef.current ? "La lectura se interrumpió. Actualizá los turnos." : "" }));
  }, [disabled]);
  const select = (client: Client | null) => {
    if (mutation.current || disabled || !sessionActive()) return;
    historyRequest.current?.abort();
    historyRequest.current = null;
    selectedRef.current = client;
    setSelected(client);
    setDraft(null);
    setSaveError("");
    setNotice("");
    setHistory(emptyRead());
    if (client) void loadHistory(client);
  };
  const searchClients = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.current || disabled || !sessionActive()) return;
    select(null); // Search owns the list; a former selection cannot keep hidden detail alive.
    void loadList(search.trim());
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const client = selectedRef.current;
    if (!client || !draft || mutation.current || disabled || !sessionActive()) return;
    const controller = new AbortController(), generation = owner.current;
    mutation.current = controller;
    listRequest.current?.abort();
    historyRequest.current?.abort();
    setPending(true);
    setList(state => ({ ...state, pending: false }));
    setHistory(state => ({ ...state, pending: false }));
    setSaveError("");
    setNotice("");
    const owns = () => current(generation, controller) && mutation.current === controller && selectedRef.current?.id === client.id;
    try {
      const saved = await api.updateClient(client.id, draft, controller.signal);
      if (!owns()) return;
      // The confirmed DTO is authoritative even if either subsequent GET fails.
      selectedRef.current = saved;
      setSelected(saved);
      setList(state => ({ ...state, rows: state.rows.map(row => row.id === saved.id ? saved : row), pending: false }));
      setHistory(state => ({ ...state, rows: state.rows.map(row => ({ ...row, client: saved })), pending: false }));
      setDraft(null);
      setNotice("Cliente guardado");
      mutation.current = null;
      listRequest.current = null;
      historyRequest.current = null;
      setPending(false);
      scheduleFocus("edit");
      // Independent read recovery cannot fall through the PUT failure branch.
      void loadList();
      void loadHistory(saved);
    } catch (cause) {
      if (!owns()) return;
      setSaveError(api.errorMessage(cause));
      setPending(false);
      scheduleFocus("save");
    } finally {
      if (mutation.current === controller) mutation.current = null;
    }
  };
  const locked = disabled || pending;
  return <main className="clients-screen" aria-labelledby="clients-title">
    <h1 id="clients-title">Clientes</h1>
    <p>Buscá por nombre o teléfono. Los turnos conservan las condiciones originales del servicio y recurso.</p>
    <form aria-label="Buscar clientes" onSubmit={searchClients}>
      <label htmlFor="clients-search">Nombre o teléfono</label>
      <input id="clients-search" value={search} disabled={locked} onChange={event => setSearch(event.target.value)} />
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
        setDraft({ firstName: selected.firstName, lastName: selected.lastName, phone: selected.phone });
        setSaveError(""); scheduleFocus("name");
      }}>Editar cliente</button> : <form ref={form} aria-label="Editar cliente" aria-busy={pending} onSubmit={save}>
        {([ ["firstName", "Nombre"], ["lastName", "Apellido"], ["phone", "Teléfono"] ] as const).map(([key, label]) =>
          <label key={key} htmlFor={`client-${key}`}>{label}
            <input id={`client-${key}`} name={key} type={key === "phone" ? "tel" : "text"} required disabled={locked}
              value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} />
          </label>)}
        {saveError && <p role="alert">{saveError}</p>}
        <button disabled={locked} type="submit">{pending ? "Guardando…" : "Guardar cambios"}</button>
        <button disabled={locked} type="button" onClick={() => { setDraft(null); setSaveError(""); scheduleFocus("edit"); }}>Cancelar</button>
      </form>}
      {history.pending && <p role="status">Cargando turnos…</p>}
      {history.error && <div className="clients-warning"><p role="alert">{notice ? "El cliente se guardó, pero no pudimos actualizar los turnos." : history.error}</p>
        <button disabled={locked || history.pending} onClick={() => void loadHistory()}>Actualizar turnos</button></div>}
      <Appointments title="Próximos turnos" rows={history.rows.filter(row => row.state === "confirmed" && row.startMs > now)} />
      <Appointments title="Historial completo" rows={history.rows} />
    </section>}
  </main>;
}
