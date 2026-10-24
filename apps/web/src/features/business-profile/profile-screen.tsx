import type { FormEventHandler, ReactNode } from "react";
import type { Profile } from "../../api/api-client";

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
};

function ProfileField({
  label,
  name,
  hint,
  maxLength,
  defaultValue,
  required = false,
  input = false,
}: FieldProps) {
  const fieldId = `profile-${name}`;
  const hintId = `${fieldId}-hint`;

  return (
    <div className="profile-field">
      <div className="profile-field__heading">
        <label className="profile-field__label" htmlFor={fieldId}>
          {label}
        </label>
        <span className="profile-field__requirement">
          {required ? "Obligatorio" : "Opcional"}
        </span>
      </div>
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
      <header className="profile-heading">
        <h1 id="profile-title">Perfil del negocio</h1>
      </header>

      <form
        id="business-profile-form"
        className="profile-form"
        onSubmit={submitAction}
        aria-busy={savePending}
        aria-labelledby="profile-title"
      >
        <div className="profile-form__fields">
          <ProfileField
            label="Nombre comercial"
            name="displayName"
            defaultValue={profile.displayName ?? ""}
            hint="El nombre con el que presentás tu negocio"
            maxLength={160}
            required
            input
          />
          <ProfileField
            label="Descripción"
            name="description"
            defaultValue={profile.description ?? ""}
            hint="Una explicación directa de tu propuesta y a quién ayudás"
            maxLength={4000}
          />
          <ProfileField
            label="Dirección"
            name="address"
            defaultValue={profile.address ?? ""}
            hint="Ubicación o zona de atención, si corresponde"
            maxLength={500}
            input
          />
        </div>

        <footer className="profile-save-panel" data-ui="profile-save-panel">
          <div className="profile-feedback" aria-label="Estado del guardado">
            {feedback}
          </div>
          <div className="profile-save-panel__action">
            <p>Los cambios se aplican al guardar el perfil.</p>
            <button
              type="submit"
              form="business-profile-form"
              disabled={savePending}
            >
              {savePending ? "Guardando…" : "Guardar perfil"}
            </button>
          </div>
        </footer>
      </form>
    </main>
  );
}
