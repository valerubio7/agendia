"use client";

import { useEffect, useRef, useState, type FormEventHandler, type ReactNode } from "react";
import type { Agent } from "../../api/api-client";
import { AGENT_STYLE_LIMIT, AGENT_BUSINESS_INSTRUCTIONS_LIMIT } from "../../../../../packages/domain/src/agent/config";
import { IntegrationIcon, IntegrationPanel } from "./integration-panel";

type AgentScreenProps = {
  agent: Partial<Agent>;
  feedback: ReactNode;
  conflict: boolean;
  savePending: boolean;
  submitAction: FormEventHandler<HTMLFormElement>;
  reloadAction: () => void;
};

const fields = [
  { name: "style", label: "Tono y personalidad", rows: 3, limit: AGENT_STYLE_LIMIT, placeholder: "¿Cómo querés que hable con tus clientes?", hint: "Cómo saluda y responde a tus clientes." },
  { name: "businessInstructions", label: "Instrucciones", rows: 4, limit: AGENT_BUSINESS_INSTRUCTIONS_LIMIT, placeholder: "Reglas y datos que debe tener en cuenta", hint: "Información y reglas para gestionar los turnos." },
] as const;

export function AgentScreen({ agent, feedback, conflict, savePending, submitAction, reloadAction }: AgentScreenProps) {
  const [active, setActive] = useState(Boolean(agent.active));
  const activationEdits = useRef(0);
  const submittedEdits = useRef(0);
  const activationChanged = active !== Boolean(agent.active);

  useEffect(() => {
    if (activationEdits.current === submittedEdits.current) setActive(Boolean(agent.active));
  }, [agent.revision, agent.active]);

  return <IntegrationPanel kind="agent" closeDisabled={savePending}>{dismiss => (
    <form id="agent-configuration-form" className="integration-form" aria-busy={savePending} onSubmit={event => {
      if (!savePending) submittedEdits.current = activationEdits.current;
      submitAction(event);
    }}>
      <div className="integration-body">
        <hr />
        <div className="integration-switch" data-ui="agent-activation">
          <span className="integration-switch-copy">
            <strong>Respuestas automáticas</strong>
            <small id="agent-activation-hint">{activationChanged ? active ? "Activación pendiente" : "Pausa pendiente" : "Activá o pausá al asistente"}</small>
          </span>
          <label className="integration-toggle">
            <input name="active" type="checkbox" checked={active} aria-label="Respuestas automáticas activas" aria-describedby="agent-activation-hint" onChange={event => {
              activationEdits.current += 1;
              setActive(event.target.checked);
            }} />
            <span aria-hidden="true">{active ? "Activo" : "Pausado"}</span>
            <span className="integration-track" aria-hidden="true" />
          </label>
        </div>
        {fields.map(({ name, label, rows, limit, placeholder, hint }) => <div key={name} className="integration-field">
          <label htmlFor={`agent-${name}`}>{label}</label>
          <textarea id={`agent-${name}`} name={name} defaultValue={agent[name] ?? ""} rows={rows} maxLength={limit}
            placeholder={placeholder} aria-describedby={`agent-${name}-hint`} />
          <small id={`agent-${name}-hint`}>{hint}<span className="integration-limit"> Hasta {limit.toLocaleString("es-AR")} caracteres.</span></small>
        </div>)}
        <div className="agent-feedback integration-feedback">
          {feedback}
          {conflict && <button className="integration-button" type="button" onClick={reloadAction}>Recargar configuración</button>}
        </div>
      </div>
      <footer className="integration-footer" data-ui="agent-save-panel">
        <button className="integration-button" type="button" disabled={savePending} onClick={dismiss}>Cancelar</button>
        <button className="integration-button integration-primary" type="submit" disabled={savePending}>
          <IntegrationIcon name="check" />{savePending ? "Guardando…" : "Guardar cambios"}
        </button>
      </footer>
    </form>
  )}</IntegrationPanel>;
}
