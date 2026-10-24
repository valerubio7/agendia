"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AppointmentRecord } from "../../api/api-client";
import type { TurnosMutation } from "./turnos-screen";
import { argentinaDate, dateLabel, turnoMoney, turnoStates, turnoTime } from "./turnos-calendar";

type FinalState = "cancelled" | "done" | "no_show";
export function TurnosDetail({ row, now, disabled, mutate, change, error }: {
  row: AppointmentRecord; now: number; disabled: boolean; mutate: TurnosMutation;
  change: () => void; error: string;
}) {
  const [notes, setNotes] = useState(row.notes ?? "");
  const [editingNotes, setEditingNotes] = useState(false);
  const [confirmation, setConfirmation] = useState<FinalState | null>(null);
  const [saving, setSaving] = useState(false);
  const guard = useRef(false), mounted = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const focus = useRef<string | null>(null);
  const scheduleFocus = (target: string) => { focus.current = target; setFocusRevision(value => value + 1); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!editingNotes) setNotes(row.notes ?? "");
    if (row.state !== "confirmed") { setConfirmation(null); setEditingNotes(false); }
  }, [row]);
  useEffect(() => {
    const target = focus.current;
    focus.current = null;
    if (disabled) return;
    const element = target === "notes" ? form.current?.querySelector<HTMLTextAreaElement>("textarea")
      : document.getElementById(`turnos-${target}`);
    if (element?.isConnected && !("disabled" in element && element.disabled)) element.focus();
  }, [focusRevision]);
  const confirmed = row.state === "confirmed", started = now >= row.startMs;
  const locked = disabled || saving;
  const saveNotes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked || guard.current || !confirmed) return;
    guard.current = true; setSaving(true);
    try {
      const saved = await mutate(signal => api.appointmentNotes(row.id, { notes: notes === "" ? null : notes }, signal));
      if (mounted.current) {
        if (saved) setEditingNotes(false);
        scheduleFocus(saved ? "detail-title" : "save-notes");
      }
    } finally { guard.current = false; if (mounted.current) setSaving(false); }
  };
  const saveState = async () => {
    if (locked || guard.current || !confirmed || !confirmation) return;
    if (confirmation !== "cancelled" && Date.now() < row.startMs) return;
    guard.current = true; setSaving(true);
    try {
      const saved = await mutate(signal => api.appointmentState(row.id, { state: confirmation, confirmed: true }, signal));
      if (mounted.current) {
        if (saved) setConfirmation(null);
        scheduleFocus(saved ? "detail-title" : "confirm-state");
      }
    } finally { guard.current = false; if (mounted.current) setSaving(false); }
  };
  return <section className="turnos-detail" aria-label="Detalle del turno" aria-busy={saving}>
    <h2 id="turnos-detail-title" tabIndex={-1}>{row.client.firstName} {row.client.lastName}</h2>
    <dl>
      <dt>Teléfono</dt><dd>{row.client.phone}</dd>
      <dt>Servicio guardado</dt><dd>{row.terms.serviceName}</dd>
      <dt>Recurso guardado</dt><dd>{row.terms.resourceName}</dd>
      <dt>Fecha y hora</dt><dd>{dateLabel(argentinaDate(row.startMs))} · {turnoTime(row.startMs)}</dd>
      <dt>Condiciones guardadas</dt><dd>{row.terms.durationMinutes} min · {turnoMoney(row.terms.priceArs)}</dd>
      <dt>Estado</dt><dd><span className="turnos-state" data-state={row.state}>{turnoStates[row.state]}</span></dd>
      <dt>Origen</dt><dd>{row.origin === "manual" ? "Manual" : "IA"}</dd>
      <dt>Notas</dt><dd>{row.notes ?? "Sin notas"}</dd>
    </dl>
    {confirmed && <>
      {started ? <p>El turno ya comenzó. No se pueden modificar servicio, recurso ni horario.</p>
        : <button className="turnos-primary" disabled={locked || !!confirmation || editingNotes} onClick={change}>Modificar turno</button>}
      {!editingNotes ? <button id="turnos-edit-notes" disabled={locked || !!confirmation} onClick={() => {
        setNotes(row.notes ?? ""); setEditingNotes(true); scheduleFocus("notes");
      }}>Editar notas</button> : <form ref={form} aria-label="Editar notas del turno" aria-busy={saving} onSubmit={saveNotes}>
        <label htmlFor="turnos-notes">Notas del turno</label>
        <textarea id="turnos-notes" disabled={locked} value={notes} onChange={event => setNotes(event.target.value)} />
        {error && <p role="alert">{error}</p>}
        <button id="turnos-save-notes" disabled={locked} type="submit">Guardar notas</button>
        <button disabled={locked} type="button" onClick={() => { setEditingNotes(false); scheduleFocus("edit-notes"); }}>Cancelar notas</button>
      </form>}
      {!confirmation ? <div className="turnos-toolbar" role="group" aria-label="Acciones de estado">
        {([ ["cancelled", "Cancelar turno"], ["done", "Marcar completado"], ["no_show", "Marcar ausente"] ] as const).map(([state, label]) =>
          <button key={state} id={`turnos-action-${state}`} disabled={locked || editingNotes || (state !== "cancelled" && !started)} onClick={() => {
            setConfirmation(state); scheduleFocus("cancel-state");
          }}>{label}</button>)}
      </div> : <section className="turnos-confirmation" aria-label="Confirmar estado del turno">
        <h3>Confirmar: {turnoStates[confirmation]}</h3>
        <p>Esta acción es definitiva. El turno no se puede reabrir y no se envía WhatsApp.</p>
        {error && <p role="alert">{error}</p>}
        <button id="turnos-confirm-state" disabled={locked} onClick={() => void saveState()}>Confirmar estado</button>
        <button id="turnos-cancel-state" disabled={locked} onClick={() => {
          const former = confirmation; setConfirmation(null); scheduleFocus(`action-${former}`);
        }}>Volver sin cambiar</button>
      </section>}
    </>}
  </section>;
}
