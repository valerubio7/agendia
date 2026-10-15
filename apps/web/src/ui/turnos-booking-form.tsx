"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AppointmentRecord, type AvailabilitySlot, type Client, type ClientInput, type Resource, type Service } from "../api-client";
import type { TurnosMutation } from "./turnos-screen";
import { argentinaDate, dateLabel, turnoMoney, turnoTime } from "./turnos-calendar";

export function TurnosBookingForm({ appointment, services, resources, disabled, sessionActive, now, mutate, error, cancel }: {
  appointment: AppointmentRecord | null; services: Service[]; resources: Resource[];
  disabled: boolean; sessionActive: () => boolean; now: number; mutate: TurnosMutation;
  error: string; cancel: () => void;
}) {
  const [source, setSource] = useState<"existing" | "new">("existing");
  const [search, setSearch] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [client, setClient] = useState<Client | null>(null);
  const [newClient, setNewClient] = useState<ClientInput>({ firstName: "", lastName: "", phone: "" });
  const [clientPending, setClientPending] = useState(false);
  const [clientError, setClientError] = useState("");
  const [serviceId, setServiceId] = useState(appointment?.terms.serviceId ?? "");
  const [resourceId, setResourceId] = useState(appointment?.terms.resourceId ?? "");
  const [date, setDate] = useState(appointment ? argentinaDate(appointment.startMs) : argentinaDate(now));
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);
  const [slotPending, setSlotPending] = useState(false);
  const [slotError, setSlotError] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const alive = useRef(false), owner = useRef(0);
  const clientRequest = useRef<AbortController | null>(null);
  const availability = useRef<AbortController | null>(null);
  const submitGuard = useRef(false);
  const identity = useRef(0);
  const selectedOffer = useRef<AvailabilitySlot | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const focus = useRef<"first" | "confirm" | "review" | null>("first");
  const scheduleFocus = (target: typeof focus.current) => { focus.current = target; setFocusRevision(value => value + 1); };
  useEffect(() => {
    const target = focus.current;
    focus.current = null;
    if (disabled || !sessionActive()) return;
    const element = form.current?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      target === "confirm" ? '[data-focus="confirm"]' : target === "review" ? '[data-focus="review"]' : 'input, select',
    );
    if (element?.isConnected && !element.disabled) element.focus();
  }, [focusRevision]);
  const owns = (generation: number, controller: AbortController) =>
    alive.current && owner.current === generation && !controller.signal.aborted && sessionActive();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; owner.current++;
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
    setSlot(null); setSlots([]); setSlotPending(false); setSlotError(""); setConfirmation(false);
  };
  const searchClients = async () => {
    if (disabled || submitGuard.current || !sessionActive()) return;
    clientRequest.current?.abort();
    const controller = new AbortController(), generation = owner.current;
    clientRequest.current = controller;
    setClient(null); setConfirmation(false); setClientPending(true); setClientError("");
    try {
      const rows = await api.clients(search, controller.signal);
      if (owns(generation, controller) && clientRequest.current === controller) setClients(rows);
    } catch (cause) {
      if (owns(generation, controller) && clientRequest.current === controller) setClientError(api.errorMessage(cause));
    } finally {
      if (clientRequest.current === controller) { clientRequest.current = null; setClientPending(false); }
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
      if (owns(generation, controller) && availability.current === controller && identity.current === requestIdentity)
        setSlots(offers);
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
    if (locked || submitGuard.current || !ready || !slot || selectedOffer.current !== slot || !sessionActive()) return;
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
  return <form ref={form} aria-label={appointment ? "Modificar turno" : "Crear turno"} aria-busy={submitting} onSubmit={submit}>
    {structuralLocked && <p role="alert">El turno ya comenzó o está finalizado. No se pueden modificar servicio, recurso ni horario.</p>}
    {!appointment && <fieldset disabled={locked || confirmation}>
      <legend>Cliente</legend>
      <label htmlFor="turnos-client-source">Origen del cliente</label>
      <select id="turnos-client-source" value={source} onChange={event => {
        clientRequest.current?.abort(); clientRequest.current = null;
        setClientPending(false); setSource(event.target.value as typeof source); setClient(null); setClients([]); invalidate();
      }}><option value="existing">Cliente existente</option><option value="new">Cliente nuevo</option></select>
      {source === "existing" ? <>
        <label htmlFor="turnos-client-search">Buscar cliente por nombre o teléfono</label>
        <input id="turnos-client-search" value={search} onChange={event => {
          clientRequest.current?.abort(); clientRequest.current = null; setClientPending(false);
          setSearch(event.target.value); setClient(null); setClients([]); invalidate();
        }} />
        <button type="button" disabled={clientPending} onClick={() => void searchClients()}>Buscar cliente</button>
        {clientPending && <p role="status">Buscando clientes…</p>}
        {clientError && <p role="alert">{clientError}</p>}
        <ul className="turnos-client-results" aria-label="Resultados de clientes">{clients.map(row => <li key={row.id}>
          <button type="button" aria-pressed={client?.id === row.id} onClick={() => { setClient(row); invalidate(); }}>
            {row.firstName} {row.lastName} · {row.phone}
          </button></li>)}</ul>
        {client && <p>Cliente seleccionado: {client.firstName} {client.lastName} · {client.phone}</p>}
      </> : <>
        {([ ["firstName", "Nombre"], ["lastName", "Apellido"], ["phone", "Teléfono"] ] as const).map(([key, label]) =>
          <label key={key} htmlFor={`turnos-new-${key}`}>{label}<input id={`turnos-new-${key}`} required
            type={key === "phone" ? "tel" : "text"} value={newClient[key]} onChange={event => {
              setNewClient(value => ({ ...value, [key]: event.target.value })); invalidate();
            }} /></label>)}
        <p>El cliente se crea junto con el turno al confirmar. Un conflicto no crea un cliente separado.</p>
      </>}
    </fieldset>}
    <fieldset disabled={locked || confirmation}>
      <legend>Servicio y horario</legend>
      <label htmlFor="turnos-service">Servicio</label>
      <select id="turnos-service" required value={serviceId} onChange={event => {
        setServiceId(event.target.value); setResourceId(""); invalidate();
      }}><option value="">Elegí un servicio</option>{activeServices.map(service =>
        <option key={service.id} value={service.id}>{service.name}</option>)}</select>
      <label htmlFor="turnos-resource">Recurso</label>
      <select id="turnos-resource" required value={resourceId} onChange={event => { setResourceId(event.target.value); invalidate(); }}>
        <option value="">Elegí un recurso</option>{eligible.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
      </select>
      <label htmlFor="turnos-date">Fecha</label>
      <input id="turnos-date" type="date" required min={argentinaDate(now)} value={date} onChange={event => { setDate(event.target.value); invalidate(); }} />
      <button type="button" disabled={slotPending || !serviceId || !resourceId || !date} onClick={() => void loadSlots()}>Consultar horarios</button>
      {slotPending && <p role="status">Consultando disponibilidad…</p>}
      {slotError && <p role="alert">{slotError}</p>}
      <label htmlFor="turnos-start">Horario disponible</label>
      <select id="turnos-start" required value={slot?.start ?? ""} onChange={event => {
        const selected = slots.find(offer => offer.start === event.target.value) ?? null;
        selectedOffer.current = selected;
        setSlot(selected); setConfirmation(false);
      }}><option value="">Elegí un horario ofrecido</option>{slots.filter(offer => validOffer(offer)).map(offer =>
        <option key={offer.start} value={offer.start}>{turnoTime(offer.startMs)} · {offer.terms.durationMinutes} min · {turnoMoney(offer.terms.priceArs)}</option>)}</select>
      {!slotPending && slots.length === 0 && <p>Consultá disponibilidad para obtener horarios libres.</p>}
      {!appointment && <label htmlFor="turnos-create-notes">Notas<textarea id="turnos-create-notes" value={notes}
        onChange={event => { setNotes(event.target.value); setConfirmation(false); }} /></label>}
    </fieldset>
    {slot && <section aria-label="Condiciones ofrecidas">
      <h3>{confirmation ? "Confirmación final" : "Condiciones ofrecidas"}</h3>
      <p>{appointment ? `${appointment.client.firstName} ${appointment.client.lastName}` : source === "new"
        ? `${newClient.firstName} ${newClient.lastName}` : `${client?.firstName ?? ""} ${client?.lastName ?? ""}`}</p>
      <p>{slot.terms.serviceName} · {slot.terms.resourceName}</p>
      <p>{dateLabel(date)} · {turnoTime(slot.startMs)} · {slot.terms.durationMinutes} min · {turnoMoney(slot.terms.priceArs)}</p>
      {appointment && <p>Cambiar solo fecha, hora o recurso conserva las condiciones guardadas. Cambiar el servicio utiliza sus condiciones actuales.</p>}
      <p>La disponibilidad se verifica nuevamente al guardar. Esta operación manual no envía WhatsApp.</p>
    </section>}
    {error && <p role="alert">{error}</p>}
    <button data-focus={confirmation ? "confirm" : "review"} type="submit" disabled={locked || !ready}>
      {submitting ? "Guardando…" : confirmation ? "Confirmar turno" : "Revisar turno"}
    </button>
    {confirmation && <button type="button" disabled={locked} onClick={() => { setConfirmation(false); scheduleFocus("review"); }}>Volver al formulario</button>}
    <button type="button" disabled={disabled || submitting} onClick={cancel}>Cancelar formulario</button>
  </form>;
}
