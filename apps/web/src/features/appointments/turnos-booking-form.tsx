"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AppointmentRecord, type AvailabilitySlot, type Client, type ClientInput, type Resource, type Service } from "../../api/api-client";
import { PanelInlineError } from "../../components/panel-feedback";
import type { TurnosMutation } from "./turnos-screen";
import { argentinaDate, dateLabel, turnoMoney, turnoTime } from "./turnos-calendar";

export function TurnosBookingForm({ appointment, initialClient, services, resources, disabled, sessionActive, now, mutate, error, onInvalid, cancel }: {
  appointment: AppointmentRecord | null; initialClient?: Client | null; services: Service[]; resources: Resource[];
  disabled: boolean; sessionActive: () => boolean; now: number; mutate: TurnosMutation;
  error: string; onInvalid: (message: string) => void; cancel: () => void;
}) {
  const [validation, setValidation] = useState("");
  const [source, setSource] = useState<"existing" | "new">("existing");
  const [search, setSearch] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [client, setClient] = useState<Client | null>(initialClient ?? null);
  const [newClient, setNewClient] = useState<ClientInput>({ firstName: "", lastName: "", phone: "" });
  const [clientPending, setClientPending] = useState(false);
  const [clientError, setClientError] = useState("");
  const [serviceId, setServiceId] = useState(appointment?.terms.serviceId ?? "");
  const [resourceId, setResourceId] = useState(appointment?.terms.resourceId ?? "");
  const [date, setDate] = useState(appointment ? argentinaDate(appointment.startMs) : argentinaDate(now));
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);
  const [slotPending, setSlotPending] = useState(false);
  const [slotsLoaded, setSlotsLoaded] = useState(false);
  const [slotError, setSlotError] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const alive = useRef(false), owner = useRef(0);
  const clientRequest = useRef<AbortController | null>(null);
  const enterRequest = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const availability = useRef<AbortController | null>(null);
  const submitGuard = useRef(false);
  const identity = useRef(0);
  const selectedOffer = useRef<AvailabilitySlot | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const focus = useRef<"confirm" | "review" | null>(null);
  const scheduleFocus = (target: typeof focus.current) => { focus.current = target; setFocusRevision(value => value + 1); };
  useEffect(() => {
    const target = focus.current;
    focus.current = null;
    if (!target || disabled || !sessionActive()) return;
    const element = form.current?.querySelector<HTMLButtonElement>(`[data-focus="${target}"]`);
    if (element?.isConnected && !element.disabled) element.focus();
  }, [focusRevision]);
  const owns = (generation: number, controller: AbortController) =>
    alive.current && owner.current === generation && !controller.signal.aborted && sessionActive();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; owner.current++;
      enterRequest.current = null;
      for (const ref of [clientRequest, availability]) {
        const controller = ref.current;
        controller?.abort();
        if (ref.current === controller) ref.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (!disabled) return;
    owner.current++;
    enterRequest.current = null;
    for (const ref of [clientRequest, availability]) {
      const controller = ref.current;
      controller?.abort();
      if (ref.current === controller) ref.current = null;
    }
    setClientPending(false); setSlotPending(false);
  }, [disabled]);
  const invalidate = () => {
    identity.current++;
    availability.current?.abort(); availability.current = null;
    selectedOffer.current = null;
    setSlot(null); setSlots([]); setSlotsLoaded(false); setSlotPending(false); setSlotError(""); setConfirmation(false);
  };
  const chooseClient = (row: Client) => {
    if (locked || submitGuard.current || !sessionActive()) return;
    enterRequest.current = null;
    setClient(row);
    invalidate();
  };
  const resetClientSearch = () => {
    enterRequest.current = null;
    clientRequest.current?.abort(); clientRequest.current = null;
    setClient(null); setClients([]); setClientPending(false); setClientError("");
    invalidate();
  };
  const searchClients = async (query: string) => {
    if (locked || submitGuard.current || !sessionActive()) return;
    resetClientSearch();
    const controller = new AbortController(), generation = owner.current;
    clientRequest.current = controller;
    setClientPending(true);
    try {
      const rows = await api.clients(query, controller.signal);
      if (owns(generation, controller) && clientRequest.current === controller) {
        setClients(rows);
        if (enterRequest.current === controller && rows[0] && searchInput.current?.matches(":focus")) chooseClient(rows[0]);
      }
    } catch (cause) {
      if (owns(generation, controller) && clientRequest.current === controller) setClientError(api.errorMessage(cause));
    } finally {
      if (enterRequest.current === controller) enterRequest.current = null;
      if (clientRequest.current === controller) {
        if (owns(generation, controller)) setClientPending(false);
        clientRequest.current = null;
      }
    }
  };
  const loadSlots = async () => {
    if (disabled || submitGuard.current || availability.current || !serviceId || !resourceId || !date || !sessionActive()) return;
    invalidate();
    const controller = new AbortController(), generation = owner.current, requestIdentity = identity.current;
    availability.current = controller;
    setSlotPending(true);
    try {
      const offers = await api.appointmentAvailability({ serviceId, resourceId, date,
        ...(appointment ? { appointmentId: appointment.id } : {}) }, controller.signal);
      if (owns(generation, controller) && availability.current === controller && identity.current === requestIdentity) {
        setSlots(offers); setSlotsLoaded(true);
      }
    } catch (cause) {
      if (owns(generation, controller) && availability.current === controller && identity.current === requestIdentity)
        setSlotError(api.errorMessage(cause));
    } finally {
      if (availability.current === controller) { availability.current = null; setSlotPending(false); }
    }
  };
  const structuralLocked = !!appointment && (appointment.state !== "confirmed" || now >= appointment.startMs);
  const validOffer = (offer: AvailabilitySlot, clock = now) => offer.startMs >= clock + 3600000
    || (!!appointment && offer.startMs === appointment.startMs && clock < appointment.startMs);
  useEffect(() => {
    if (slot && (!validOffer(slot) || structuralLocked)) invalidate();
  }, [now, structuralLocked]);
  const locked = disabled || submitting || structuralLocked;
  const eligible = resources.filter(resource => resource.status === "active" && resource.serviceIds.includes(serviceId));
  const activeServices = services.filter(service => service.status === "active");
  const ready = slot && validOffer(slot) && (appointment || (source === "existing" ? client :
    newClient.firstName.trim() && newClient.lastName.trim() && newClient.phone.trim()));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    enterRequest.current = null;
    if (locked || submitGuard.current || !sessionActive()) return;
    if (!confirmation) {
      const message = !activeServices.some(service => service.id === serviceId) ? "Elegí el servicio antes de guardar."
        : !appointment && source === "existing" && !client ? "Elegí el cliente antes de guardar."
        : !eligible.some(resource => resource.id === resourceId) ? "Seleccioná un profesional que realice el servicio."
        : !date || date < argentinaDate(now) || !slot || !validOffer(slot) ? "Seleccioná una fecha válida y un horario."
        : !appointment && source === "new" && (!newClient.firstName.trim() || !newClient.lastName.trim() || !newClient.phone.trim())
          ? "Completá nombre, apellido y un teléfono válido." : "";
      setValidation(message);
      if (message) { onInvalid(message); return; }
    }
    if (!ready || !slot || selectedOffer.current !== slot) return;
    if (!confirmation) { setConfirmation(true); scheduleFocus("confirm"); return; }
    // Recheck the actual clock synchronously, not only the last rendered timer tick.
    if (!validOffer(slot, Date.now()) || (appointment && Date.now() >= appointment.startMs)) { invalidate(); return; }
    submitGuard.current = true; setSubmitting(true);
    const terms = slot.terms;
    const structure = { serviceId, resourceId, date, startRaw: slot.start, expectedTerms: terms, confirmed: true as const };
    try {
      const saved = await mutate(signal => appointment
        ? api.changeAppointment(appointment.id, structure, signal)
        : api.createAppointment({ ...structure,
          ...(source === "existing" ? { clientId: client!.id } : { newClient }),
          ...(notes ? { notes } : {}),
        }, signal));
      if (!saved && alive.current && sessionActive()) scheduleFocus("confirm");
    } finally {
      submitGuard.current = false;
      if (alive.current) setSubmitting(false);
    }
  };
  const customer = appointment?.client ?? (source === "new" ? newClient : client);
  const visibleSlots = slots.filter(offer => validOffer(offer));
  return <form ref={form} aria-label={appointment ? "Modificar turno" : "Crear turno"} aria-busy={submitting} noValidate onSubmit={submit}>
    {structuralLocked && <PanelInlineError message="El turno ya comenzó o está finalizado. No se pueden modificar servicio, recurso ni horario." />}
    <div className="booking-grid" hidden={confirmation}>
      <div className="booking-column">
        <fieldset className="booking-panel booking-client" disabled={locked || confirmation}>
          <legend>Cliente</legend>
          {appointment || initialClient ? <p><strong>{customer?.firstName} {customer?.lastName}</strong><br />{customer?.phone}</p> : <>
            <div className="booking-mode" role="group" aria-label="Tipo de cliente">
              {([["existing", "Cliente registrado"], ["new", "Nuevo cliente"]] as const).map(([mode, label]) =>
                <button key={mode} type="button" aria-pressed={source === mode} onClick={() => {
                  if (source === mode || locked || submitGuard.current || !sessionActive()) return;
                  resetClientSearch();
                  setSource(mode);
                }}>{label}</button>)}
            </div>
            {source === "existing" ? <>
              <label htmlFor="turnos-client-search">Buscar cliente por nombre o teléfono</label>
              <div className="booking-search">
                <input id="turnos-client-search" ref={searchInput} autoComplete="off" placeholder="Nombre, apellido o teléfono" value={search}
                  onBlur={() => { enterRequest.current = null; }} onChange={event => {
                  if (locked || submitGuard.current || !sessionActive()) return;
                  const value = event.target.value;
                  setSearch(value);
                  if (value.trim()) void searchClients(value);
                  else resetClientSearch();
                }} onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Escape") enterRequest.current = null;
                  if (event.key !== "Enter") return;
                  event.preventDefault(); // Search Enter must not submit the booking form.
                  if (locked || submitGuard.current || !sessionActive()) return;
                  if (clientRequest.current) enterRequest.current = clientRequest.current;
                  else if (!clientPending && clients[0] && client?.id !== clients[0].id) chooseClient(clients[0]);
                }} />
                <button type="button" disabled={clientPending} onClick={() => {
                  if (!clientRequest.current) void searchClients(search);
                }}>Buscar cliente</button>
              </div>
              {clientPending && <p role="status">Buscando clientes…</p>}
              {clientError && <PanelInlineError message={clientError} />}
              {clients.length > 0 && <ul className="turnos-client-results" aria-label="Resultados de clientes">{clients.map(row => <li key={row.id}>
                <button type="button" aria-pressed={client?.id === row.id} onClick={() => {
                  if (!clientRequest.current && client?.id !== row.id) chooseClient(row);
                }}>
                  <strong>{row.firstName} {row.lastName}</strong><small>{row.phone}</small>
                </button></li>)}</ul>}
            </> : <>
              <div className="booking-pair">
                {([["firstName", "Nombre"], ["lastName", "Apellido"], ["phone", "Teléfono"]] as const).map(([key, label]) =>
                  <label key={key} htmlFor={`turnos-new-${key}`}>{label}<input id={`turnos-new-${key}`} required
                    type={key === "phone" ? "tel" : "text"} value={newClient[key]} onChange={event => {
                      setNewClient(value => ({ ...value, [key]: event.target.value })); invalidate();
                    }} /></label>)}
              </div>
              <p>El cliente se crea junto con el turno al confirmar. Un conflicto no crea un cliente separado.</p>
            </>}
          </>}
        </fieldset>
        <fieldset disabled={locked || confirmation}>
          <legend>Servicio</legend>
          {activeServices.length === 0 && <p>No hay servicios activos.</p>}
          {activeServices.map(service => <label className="booking-service" key={service.id}>
            <input type="radio" name="turnos-service" value={service.id} required checked={serviceId === service.id}
              onChange={() => { setServiceId(service.id); setResourceId(""); invalidate(); }} />
            <span><strong>{service.name}</strong><small>{service.durationMinutes} min</small></span>
            <strong>{turnoMoney(service.priceArs)}</strong>
          </label>)}
        </fieldset>
      </div>
      <div className="booking-column">
        <fieldset className="booking-panel" disabled={locked || confirmation}>
          <legend>Fecha y horario</legend>
          <div className="booking-pair">
            <label htmlFor="turnos-date">Fecha<input id="turnos-date" type="date" required min={argentinaDate(now)} value={date}
              onChange={event => { setDate(event.target.value); invalidate(); }} /></label>
            <label htmlFor="turnos-resource"><span id="turnos-resource-label">Recurso</span>
              <select id="turnos-resource" aria-labelledby="turnos-resource-label" required value={resourceId}
                onChange={event => { setResourceId(event.target.value); invalidate(); }}>
              <option value="">{serviceId ? "Elegí un recurso" : "Elegí un servicio primero"}</option>
              {eligible.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
            </select></label>
          </div>
          <button type="button" disabled={slotPending || !serviceId || !resourceId || !date} onClick={() => void loadSlots()}>Consultar horarios</button>
          {slotPending && <p role="status">Consultando disponibilidad…</p>}
          {slotError && <PanelInlineError message={slotError} />}
          {visibleSlots.length > 0 ? <div className="booking-slots" role="group" aria-label="Horarios disponibles">
            {visibleSlots.map(offer => <label key={offer.start} className="booking-slot">
              <input type="radio" name="turnos-start" value={offer.start} required checked={slot === offer} onChange={() => {
                selectedOffer.current = offer; setSlot(offer); setConfirmation(false);
              }} />
              <span>{turnoTime(offer.startMs)}</span>
            </label>)}
          </div> : !slotPending && !slotError && <p className="booking-slot-empty" role="status">{slotsLoaded
            ? "No hay horarios disponibles. Probá otra fecha o recurso."
            : "Consultá disponibilidad para obtener horarios libres."}</p>}
        </fieldset>
        {!appointment && <label htmlFor="turnos-create-notes">Notas internas (opcional)<textarea id="turnos-create-notes" disabled={locked || confirmation}
          placeholder="Observaciones sobre la reserva" value={notes} onChange={event => { setNotes(event.target.value); setConfirmation(false); }} /></label>}
      </div>
    </div>
    {slot && confirmation && <section className="booking-panel booking-review" aria-labelledby="booking-review-title">
      <h3 id="booking-review-title">Revisá el turno</h3>
      <dl className="booking-facts">
        <div><dt>Cliente</dt><dd>{customer?.firstName} {customer?.lastName}<small>{customer?.phone}</small></dd></div>
        <div><dt>Fecha y hora</dt><dd>{dateLabel(date)} · {turnoTime(slot.startMs)}</dd></div>
        <div><dt>Servicio</dt><dd>{slot.terms.serviceName}</dd></div>
        <div><dt>Recurso</dt><dd>{slot.terms.resourceName}</dd></div>
        {notes && <div><dt>Notas internas</dt><dd>{notes}</dd></div>}
      </dl>
      {appointment && <p>Cambiar solo fecha, hora o recurso conserva las condiciones guardadas. Cambiar el servicio utiliza sus condiciones actuales.</p>}
      <p>La disponibilidad se verifica nuevamente al guardar. Esta operación manual no envía WhatsApp.</p>
    </section>}
    <PanelInlineError message={validation || error} />
    <footer className="booking-footer">
      {slot ? <section className="booking-quote" aria-label="Condiciones ofrecidas">
        {slot.terms.durationMinutes} min · {turnoMoney(slot.terms.priceArs)}
      </section> : <p className="booking-quote">Elegí un horario para ver las condiciones.</p>}
      <button type="button" disabled={disabled || submitting} onClick={cancel}>Cancelar formulario</button>
      {confirmation && <button type="button" disabled={locked} onClick={() => { setConfirmation(false); scheduleFocus("review"); }}>Volver al formulario</button>}
      <button className="turnos-primary" data-focus={confirmation ? "confirm" : "review"} type="submit" disabled={locked || (confirmation && !ready)}>
        {submitting ? "Guardando…" : confirmation ? "Confirmar turno" : "Revisar turno"}
      </button>
    </footer>
  </form>;
}
