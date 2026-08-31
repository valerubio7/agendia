"use client";

import {
  useEffect,
  useState,
  type FormEventHandler,
  type ReactNode,
} from "react";
import type { Assistant } from "../api-client";

type AssistantScreenProps = {
  assistant: Partial<Assistant>;
  feedback: ReactNode;
  savePending: boolean;
  submitAction: FormEventHandler<HTMLFormElement>;
};

type AssistantFieldProps = {
  label: string;
  name:
    | "personality"
    | "tone"
    | "instructions"
    | "knowledge"
    | "rules"
    | "restrictions";
  hint: string;
  defaultValue: string;
};

function AssistantField({
  label,
  name,
  hint,
  defaultValue,
}: AssistantFieldProps) {
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
        maxLength={8000}
        aria-describedby={hintId}
      />
      <span className="assistant-field__hint" id={hintId}>
        {hint} · Hasta 8.000 caracteres
      </span>
    </div>
  );
}

export function AssistantScreen({
  assistant,
  feedback,
  savePending,
  submitAction,
}: AssistantScreenProps) {
  const [active, setActive] = useState(Boolean(assistant.active));
  const savedActive = Boolean(assistant.active);
  const activationChanged = active !== savedActive;

  useEffect(() => {
    setActive(Boolean(assistant.active));
  }, [assistant.revision, assistant.active]);

  return (
    <main className="assistant-screen" data-ui="assistant-screen">
      <section
        className="assistant-hero"
        data-ui="assistant-hero"
        aria-labelledby="assistant-title"
      >
        <div className="assistant-hero__copy">
          <p className="assistant-hero__eyebrow">Dirección del asistente</p>
          <h1 id="assistant-title">Una voz que suena a tu negocio.</h1>
          <p>
            Escribí los criterios que guían cada respuesta: cómo expresarse, qué
            contexto considerar y qué límites respetar.
          </p>
        </div>

        <div
          className="assistant-signal"
          aria-label="La dirección del asistente combina voz, contexto y límites"
        >
          <div className="assistant-signal__header">
            <span>Señal de dirección</span>
            <span aria-hidden="true">
              agend<strong>IA</strong>
            </span>
          </div>
          <div className="assistant-signal__stage" aria-hidden="true">
            <span className="assistant-signal__orbit assistant-signal__orbit--outer" />
            <span className="assistant-signal__orbit assistant-signal__orbit--inner" />
            <span className="assistant-signal__core">IA</span>
            <span className="assistant-signal__pulse assistant-signal__pulse--one" />
            <span className="assistant-signal__pulse assistant-signal__pulse--two" />
          </div>
          <ol className="assistant-signal__legend">
            <li>
              <span>01</span>
              <strong>Voz</strong>
              <small>Identidad al expresarse</small>
            </li>
            <li>
              <span>02</span>
              <strong>Contexto</strong>
              <small>Criterio para responder</small>
            </li>
            <li>
              <span>03</span>
              <strong>Límites</strong>
              <small>Marcos que debe respetar</small>
            </li>
          </ol>
        </div>
      </section>

      <div className="assistant-feedback" aria-label="Estado del guardado">
        {feedback}
      </div>

      <div className="assistant-layout">
        <form
          id="assistant-configuration-form"
          className="assistant-form"
          onSubmit={submitAction}
          aria-busy={savePending}
        >
          <section
            className="assistant-section assistant-section--voice"
            aria-labelledby="assistant-voice-title"
          >
            <header className="assistant-section__header">
              <div className="assistant-section__marker" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
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
                label="Personalidad"
                name="personality"
                defaultValue={assistant.personality ?? ""}
                hint="Describí los rasgos que deben sentirse en la manera de responder"
              />
              <AssistantField
                label="Tono"
                name="tone"
                defaultValue={assistant.tone ?? ""}
                hint="Indicá el estilo de lenguaje y el grado de formalidad"
              />
            </div>
          </section>

          <section
            className="assistant-section assistant-section--context"
            aria-labelledby="assistant-context-title"
          >
            <header className="assistant-section__header">
              <span className="assistant-section__index" aria-hidden="true">
                02 / ENFOQUE
              </span>
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
                label="Instrucciones"
                name="instructions"
                defaultValue={assistant.instructions ?? ""}
                hint="Explicá cómo querés que aborde y organice las consultas"
              />
              <AssistantField
                label="Conocimiento"
                name="knowledge"
                defaultValue={assistant.knowledge ?? ""}
                hint="Agregá contexto específico que ayude a interpretar lo que preguntan"
              />
            </div>
          </section>

          <section
            className="assistant-section assistant-section--limits"
            aria-labelledby="assistant-limits-title"
          >
            <header className="assistant-section__header">
              <span className="assistant-section__boundary" aria-hidden="true">
                LÍMITE
              </span>
              <div>
                <p>El marco de actuación</p>
                <h2 id="assistant-limits-title">Reglas y límites</h2>
                <span>
                  Dejá por escrito qué pautas seguir y qué cosas nunca debe
                  hacer o afirmar.
                </span>
              </div>
            </header>
            <div className="assistant-section__fields">
              <AssistantField
                label="Reglas"
                name="rules"
                defaultValue={assistant.rules ?? ""}
                hint="Detallá pautas que debe aplicar de forma consistente"
              />
              <AssistantField
                label="Restricciones"
                name="restrictions"
                defaultValue={assistant.restrictions ?? ""}
                hint="Aclarale qué acciones, temas o afirmaciones debe evitar"
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
                onChange={(event) => setActive(event.target.checked)}
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
