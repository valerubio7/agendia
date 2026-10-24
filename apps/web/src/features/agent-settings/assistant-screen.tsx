"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEventHandler,
  type ReactNode,
} from "react";
import type { Assistant } from "../../api/api-client";
import { ASSISTANT_STYLE_LIMIT, ASSISTANT_BUSINESS_INSTRUCTIONS_LIMIT } from "../../../../../packages/domain/src/agent/config";

type AssistantScreenProps = {
  assistant: Partial<Assistant>;
  feedback: ReactNode;
  conflict: boolean;
  savePending: boolean;
  submitAction: FormEventHandler<HTMLFormElement>;
  reloadAction: () => void;
};

type AssistantFieldProps = {
  label: string;
  name: "style" | "businessInstructions";
  hint: string;
  defaultValue: string;
};

function AssistantField({
  label,
  name,
  hint,
  defaultValue,
}: AssistantFieldProps) {
  const limit = name === "style" ? ASSISTANT_STYLE_LIMIT : ASSISTANT_BUSINESS_INSTRUCTIONS_LIMIT;
  const fieldId = `assistant-${name}`;
  const hintId = `${fieldId}-hint`;

  return (
    <div className="assistant-field">
      <label className="assistant-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <textarea
        id={fieldId}
        name={name}
        defaultValue={defaultValue}
        maxLength={limit}
        aria-describedby={hintId}
      />
      <span className="assistant-field__hint" id={hintId}>
        {hint} · Hasta {limit.toLocaleString("es-AR")} caracteres
      </span>
    </div>
  );
}

export function AssistantScreen({
  assistant,
  feedback,
  conflict,
  savePending,
  submitAction,
  reloadAction,
}: AssistantScreenProps) {
  const [active, setActive] = useState(Boolean(assistant.active));
  const activationEdits = useRef(0);
  const submittedEdits = useRef(0);
  const savedActive = Boolean(assistant.active);
  const activationChanged = active !== savedActive;

  useEffect(() => {
    if (activationEdits.current === submittedEdits.current) setActive(Boolean(assistant.active));
  }, [assistant.revision, assistant.active]);

  return (
    <main className="assistant-screen" data-ui="assistant-screen">
      <section
        className="assistant-heading"
        data-ui="assistant-hero"
        aria-labelledby="assistant-title"
      >
        <h1 id="assistant-title">Asistente</h1>
      </section>

      <div className="assistant-feedback" aria-label="Estado del guardado">
        {feedback}
        {conflict && (
          <button
            className="assistant-conflict-action"
            type="button"
            onClick={reloadAction}
          >
            Recargar configuración
          </button>
        )}
      </div>

      <div className="assistant-layout">
        <form
          id="assistant-configuration-form"
          className="assistant-form"
          onSubmit={(event) => {
            if (!savePending) submittedEdits.current = activationEdits.current;
            submitAction(event);
          }}
          aria-busy={savePending}
        >
          <section
            className="assistant-section assistant-section--voice"
            aria-labelledby="assistant-voice-title"
          >
            <header className="assistant-section__header">
              <div>
                <p>El carácter de cada mensaje</p>
                <h2 id="assistant-voice-title">Voz y personalidad</h2>
                <span>
                  Definí los rasgos y el tono que hacen reconocible la forma de
                  hablar de tu negocio.
                </span>
              </div>
            </header>
            <div className="assistant-section__fields">
              <AssistantField
                label="Estilo de atención"
                name="style"
                defaultValue={assistant.style ?? ""}
                hint="Describí la personalidad y el tono que deben sentirse en la manera de responder"
              />
            </div>
          </section>

          <section
            className="assistant-section assistant-section--context"
            aria-labelledby="assistant-context-title"
          >
            <header className="assistant-section__header">
              <div>
                <p>La dirección de la respuesta</p>
                <h2 id="assistant-context-title">Contexto y dirección</h2>
                <span>
                  Sumá el criterio general y el conocimiento que deben orientar
                  sus respuestas.
                </span>
              </div>
            </header>
            <div className="assistant-section__fields">
              <AssistantField
                label="Indicaciones del negocio"
                name="businessInstructions"
                defaultValue={assistant.businessInstructions ?? ""}
                hint="Agregá instrucciones, conocimiento, reglas y restricciones para sus respuestas"
              />
            </div>
          </section>

          <section
            className={`assistant-activation${
              active ? " assistant-activation--active" : ""
            }`}
            data-ui="assistant-activation"
            aria-label="Control operativo del asistente"
          >
            <div className="assistant-activation__status" aria-hidden="true">
              <span />
              {activationChanged
                ? active
                  ? "Activación pendiente"
                  : "Pausa pendiente"
                : active
                  ? "Activo"
                  : "En pausa"}
            </div>
            <div className="assistant-activation__copy">
              <p>Control operativo</p>
              <h2 id="assistant-activation-title">
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
            <label className="assistant-activation__switch">
              <input
                name="active"
                type="checkbox"
                checked={active}
                onChange={(event) => {
                  activationEdits.current += 1;
                  setActive(event.target.checked);
                }}
              />
              <span className="assistant-activation__track" aria-hidden="true">
                <span />
              </span>
              <strong>Respuestas automáticas activas</strong>
            </label>
          </section>
        </form>

        <aside
          className="assistant-rail"
          aria-label="Guía para dirigir el asistente"
        >
          <div className="assistant-rail__guide">
            <p className="assistant-rail__eyebrow">Criterios claros</p>
            <h2>Escribí para orientar</h2>
            <ul>
              <li>Usá indicaciones concretas y sin contradicciones.</li>
              <li>Separá el estilo de las reglas obligatorias.</li>
              <li>Revisá que los límites sean explícitos.</li>
            </ul>
          </div>
          <div className="assistant-save-panel" data-ui="assistant-save-panel">
            <p>
              Los cambios de dirección y activación se aplican cuando guardás.
            </p>
            <button
              type="submit"
              form="assistant-configuration-form"
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
