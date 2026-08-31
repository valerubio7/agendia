import type { FormEventHandler, ReactNode } from "react";
import type { Profile } from "../api-client";

type ProfileScreenProps = {
  profile: Partial<Profile>;
  feedback: ReactNode;
  savePending: boolean;
  submitAction: FormEventHandler<HTMLFormElement>;
};

type FieldProps = {
  label: string;
  name: keyof Profile;
  hint: string;
  maxLength: number;
  defaultValue: string;
  required?: boolean;
  input?: boolean;
  className?: string;
};

function ProfileField({
  label,
  name,
  hint,
  maxLength,
  defaultValue,
  required = false,
  input = false,
  className = "",
}: FieldProps) {
  const fieldId = `profile-${name}`;
  const hintId = `${fieldId}-hint`;
  const fieldClassName = `profile-field${className ? ` ${className}` : ""}`;

  return (
    <div className={fieldClassName}>
      <label className="profile-field__label" htmlFor={fieldId}>
        {label}
      </label>
      {input ? (
        <input
          id={fieldId}
          name={name}
          type="text"
          defaultValue={defaultValue}
          required={required}
          maxLength={maxLength}
          aria-describedby={hintId}
        />
      ) : (
        <textarea
          id={fieldId}
          name={name}
          defaultValue={defaultValue}
          maxLength={maxLength}
          aria-describedby={hintId}
        />
      )}
      <span className="profile-field__hint" id={hintId}>
        {hint} · Hasta {maxLength.toLocaleString("es-AR")} caracteres
      </span>
    </div>
  );
}

export function ProfileScreen({
  profile,
  feedback,
  savePending,
  submitAction,
}: ProfileScreenProps) {
  return (
    <main className="profile-screen" data-ui="profile-screen">
      <section
        className="profile-hero"
        data-ui="profile-hero"
        aria-labelledby="profile-title"
      >
        <div className="profile-hero__copy">
          <p className="profile-hero__eyebrow">Base de conocimiento</p>
          <h1 id="profile-title">Tu negocio, explicado con claridad.</h1>
          <p>
            Organizá la información real que el asistente usa para entender tu
            negocio y responder con precisión.
          </p>
        </div>

        <div
          className="profile-knowledge-map"
          aria-label="La información del perfil se organiza en Identidad, Operación y Conocimiento"
        >
          <div className="profile-knowledge-map__heading">
            <span>Mapa de información</span>
            <span aria-hidden="true">
              agend<strong>IA</strong>
            </span>
          </div>
          <ol>
            <li>
              <span>01</span>
              <strong>Identidad</strong>
              <small>Quién sos y cómo contactarte</small>
            </li>
            <li>
              <span>02</span>
              <strong>Operación</strong>
              <small>Qué ofrecés y cuándo atendés</small>
            </li>
            <li>
              <span>03</span>
              <strong>Conocimiento</strong>
              <small>Cómo resolver dudas habituales</small>
            </li>
          </ol>
        </div>
      </section>

      <div className="profile-feedback" aria-label="Estado del guardado">
        {feedback}
      </div>

      <div className="profile-layout">
        <form
          id="business-profile-form"
          className="profile-form"
          onSubmit={submitAction}
          aria-busy={savePending}
        >
          <section
            className="profile-section profile-section--identity"
            aria-labelledby="profile-identity-title"
          >
            <header className="profile-section__header">
              <span className="profile-section__number" aria-hidden="true">
                01
              </span>
              <div>
                <p>El punto de partida</p>
                <h2 id="profile-identity-title">Identidad y contacto</h2>
                <span>
                  Contá qué hace único a tu negocio y dejá claros sus canales de
                  contacto.
                </span>
              </div>
            </header>
            <div className="profile-section__fields profile-section__fields--identity">
              <ProfileField
                label="Nombre comercial"
                name="displayName"
                defaultValue={profile.displayName ?? ""}
                hint="El nombre con el que presentás tu negocio"
                maxLength={160}
                required
                input
                className="profile-field--name"
              />
              <ProfileField
                label="Descripción"
                name="description"
                defaultValue={profile.description ?? ""}
                hint="Una explicación directa de tu propuesta y a quién ayudás"
                maxLength={4000}
                className="profile-field--wide"
              />
              <ProfileField
                label="Dirección"
                name="address"
                defaultValue={profile.address ?? ""}
                hint="Ubicación o zona de atención, si corresponde"
                maxLength={500}
                input
              />
              <ProfileField
                label="Contacto"
                name="contact"
                defaultValue={profile.contact ?? ""}
                hint="Canales que las personas pueden usar para comunicarse"
                maxLength={500}
                input
              />
            </div>
          </section>

          <section
            className="profile-section profile-section--operation"
            aria-labelledby="profile-operation-title"
          >
            <header className="profile-section__header">
              <span className="profile-section__number" aria-hidden="true">
                02
              </span>
              <div>
                <p>La práctica cotidiana</p>
                <h2 id="profile-operation-title">Operación diaria</h2>
                <span>
                  Reuní los datos que ayudan a responder consultas concretas
                  sobre atención y oferta.
                </span>
              </div>
            </header>
            <div className="profile-section__fields profile-section__fields--operation">
              <ProfileField
                label="Horarios"
                name="businessHours"
                defaultValue={profile.businessHours ?? ""}
                hint="Escribí días, franjas horarias y excepciones en texto libre"
                maxLength={2000}
              />
              <ProfileField
                label="Servicios o productos"
                name="offerings"
                defaultValue={profile.offerings ?? ""}
                hint="Detallá lo que ofrecés con nombres comprensibles"
                maxLength={8000}
              />
            </div>
          </section>

          <section
            className="profile-section profile-section--knowledge"
            aria-labelledby="profile-knowledge-title"
          >
            <header className="profile-section__header">
              <span className="profile-section__number" aria-hidden="true">
                03
              </span>
              <div>
                <p>El criterio para responder</p>
                <h2 id="profile-knowledge-title">
                  Conocimiento para responder
                </h2>
                <span>
                  Documentá respuestas y reglas para que la información sea
                  consistente.
                </span>
              </div>
            </header>
            <div className="profile-section__fields profile-section__fields--knowledge">
              <ProfileField
                label="Preguntas frecuentes"
                name="faq"
                defaultValue={profile.faq ?? ""}
                hint="Anotá preguntas reales junto con la respuesta correcta"
                maxLength={8000}
                className="profile-field--wide"
              />
              <ProfileField
                label="Políticas"
                name="policies"
                defaultValue={profile.policies ?? ""}
                hint="Aclaraciones sobre cambios, reservas, pagos u otras condiciones"
                maxLength={8000}
              />
              <ProfileField
                label="Información adicional"
                name="additionalInfo"
                defaultValue={profile.additionalInfo ?? ""}
                hint="Sumá contexto útil que no encaje en las secciones anteriores"
                maxLength={8000}
              />
            </div>
          </section>
        </form>

        <aside
          className="profile-rail"
          aria-label="Guía para completar el perfil"
        >
          <div className="profile-rail__guide">
            <p className="profile-rail__eyebrow">Una fuente confiable</p>
            <h2>Antes de guardar</h2>
            <ul>
              <li>Usá información vigente y específica.</li>
              <li>Escribí como querés que se explique tu negocio.</li>
              <li>Separá cada tema para facilitar su lectura.</li>
            </ul>
          </div>
          <div className="profile-save-panel" data-ui="profile-save-panel">
            <p>Los cambios se aplican al guardar el perfil.</p>
            <button
              type="submit"
              form="business-profile-form"
              disabled={savePending}
            >
              {savePending ? "Guardando…" : "Guardar perfil"}
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
