"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEventHandler,
  type ReactNode,
} from "react";
import type { Agent } from "../../api/api-client";
import { AGENT_STYLE_LIMIT, AGENT_BUSINESS_INSTRUCTIONS_LIMIT } from "../../../../../packages/domain/src/agent/config";

type AgentScreenProps = {
  agent: Partial<Agent>;
  feedback: ReactNode;
  conflict: boolean;
  savePending: boolean;
  submitAction: FormEventHandler<HTMLFormElement>;
  reloadAction: () => void;
};

type AgentFieldProps = {
  label: string;
  name: "style" | "businessInstructions";
  hint: string;
  defaultValue: string;
};

function AgentField({
  label,
  name,
  hint,
  defaultValue,
}: AgentFieldProps) {
  const limit = name === "style" ? AGENT_STYLE_LIMIT : AGENT_BUSINESS_INSTRUCTIONS_LIMIT;
  const fieldId = `agent-${name}`;
  const hintId = `${fieldId}-hint`;

  return (
    <div className="agent-field">
      <label className="agent-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <textarea
        id={fieldId}
        name={name}
        defaultValue={defaultValue}
        maxLength={limit}
        aria-describedby={hintId}
      />
      <span className="agent-field__hint" id={hintId}>
        {hint} · Hasta {limit.toLocaleString("es-AR")} caracteres
      </span>
    </div>
  );
}

export function AgentScreen({
  agent,
  feedback,
  conflict,
  savePending,
  submitAction,
  reloadAction,
}: AgentScreenProps) {
  const [active, setActive] = useState(Boolean(agent.active));
  const activationEdits = useRef(0);
  const submittedEdits = useRef(0);
  const savedActive = Boolean(agent.active);
  const activationChanged = active !== savedActive;

  useEffect(() => {
    if (activationEdits.current === submittedEdits.current) setActive(Boolean(agent.active));
  }, [agent.revision, agent.active]);

  return (
    <main className="agent-screen" data-ui="agent-screen">
      <section
        className="agent-heading"
        data-ui="agent-hero"
        aria-labelledby="agent-title"
      >
        <h1 id="agent-title">Agente</h1>
      </section>

      <div className="agent-feedback" aria-label="Estado del guardado">
        {feedback}
        {conflict && (
          <button
            className="agent-conflict-action"
            type="button"
            onClick={reloadAction}
          >
            Recargar configuración
          </button>
        )}
      </div>

      <div className="agent-layout">
        <form
          id="agent-configuration-form"
          className="agent-form"
          onSubmit={(event) => {
            if (!savePending) submittedEdits.current = activationEdits.current;
            submitAction(event);
          }}
          aria-busy={savePending}
        >
          <section
            className="agent-section agent-section--voice"
            aria-labelledby="agent-voice-title"
          >
            <header className="agent-section__header">
              <div>
                <p>El carácter de cada mensaje</p>
                <h2 id="agent-voice-title">Voz y personalidad</h2>
                <span>
                  Definí los rasgos y el tono que hacen reconocible la forma de
                  hablar de tu negocio.
                </span>
              </div>
            </header>
            <div className="agent-section__fields">
              <AgentField
                label="Estilo de atención"
                name="style"
                defaultValue={agent.style ?? ""}
                hint="Describí la personalidad y el tono que deben sentirse en la manera de responder"
              />
            </div>
          </section>

          <section
            className="agent-section agent-section--context"
            aria-labelledby="agent-context-title"
          >
            <header className="agent-section__header">
              <div>
                <p>La dirección de la respuesta</p>
                <h2 id="agent-context-title">Contexto y dirección</h2>
                <span>
                  Sumá el criterio general y el conocimiento que deben orientar
                  sus respuestas.
                </span>
              </div>
            </header>
            <div className="agent-section__fields">
              <AgentField
                label="Indicaciones del negocio"
                name="businessInstructions"
                defaultValue={agent.businessInstructions ?? ""}
                hint="Agregá instrucciones, conocimiento, reglas y restricciones para sus respuestas"
              />
            </div>
          </section>

          <section
            className={`agent-activation${
              active ? " agent-activation--active" : ""
            }`}
            data-ui="agent-activation"
            aria-label="Control operativo del agente"
          >
            <div className="agent-activation__status" aria-hidden="true">
              <span />
              {activationChanged
                ? active
                  ? "Activación pendiente"
                  : "Pausa pendiente"
                : active
                  ? "Activo"
                  : "En pausa"}
            </div>
            <div className="agent-activation__copy">
              <p>Control operativo</p>
              <h2 id="agent-activation-title">
                {activationChanged
                  ? active
                    ? "Se activarán al guardar"
                    : "Se pausarán al guardar"
                  : active
                    ? "Respuestas automáticas activas"
                    : "Respuestas automáticas en pausa"}
              </h2>
              <span>
                La activación habilita respuestas automáticas, pero su operación
                también depende de que el negocio esté disponible, de sus
                horarios de atención y de la conexión de WhatsApp.
              </span>
            </div>
            <label className="agent-activation__switch">
              <input
                name="active"
                type="checkbox"
                checked={active}
                onChange={(event) => {
                  activationEdits.current += 1;
                  setActive(event.target.checked);
                }}
              />
              <span className="agent-activation__track" aria-hidden="true">
                <span />
              </span>
              <strong>Respuestas automáticas activas</strong>
            </label>
          </section>
        </form>

        <aside
          className="agent-rail"
          aria-label="Guía para dirigir el agente"
        >
          <div className="agent-rail__guide">
            <p className="agent-rail__eyebrow">Criterios claros</p>
            <h2>Escribí para orientar</h2>
            <ul>
              <li>Usá indicaciones concretas y sin contradicciones.</li>
              <li>Separá el estilo de las reglas obligatorias.</li>
              <li>Revisá que los límites sean explícitos.</li>
            </ul>
          </div>
          <div className="agent-save-panel" data-ui="agent-save-panel">
            <p>
              Los cambios de dirección y activación se aplican cuando guardás.
            </p>
            <button
              type="submit"
              form="agent-configuration-form"
              disabled={savePending}
            >
              {savePending
                ? "Guardando…"
                : active
                  ? "Guardar y activar"
                  : "Guardar configuración"}
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
