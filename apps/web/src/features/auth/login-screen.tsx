import type { FormEventHandler, ReactNode } from "react";
import { Brand } from "../../components/brand";

type LoginScreenProps = {
  title?: string;
  feedback: ReactNode;
  loginPending: boolean;
  submitAction: FormEventHandler<HTMLFormElement>;
};

export function LoginScreen({
  title = "Iniciar sesión",
  feedback,
  loginPending,
  submitAction,
}: LoginScreenProps) {
  return (
    <main className="login-frame" data-ui="login-frame">
      <section
        className="login-form-panel"
        data-ui="login-form-panel"
        aria-labelledby="login-title"
      >
        <div className="login-card">
          <Brand />
          <h1 id="login-title">{title}</h1>
          <p className="login-welcome">Qué bueno verte de nuevo.</p>
          {feedback}
          <form onSubmit={submitAction} aria-busy={loginPending}>
            <label className="login-field">
              Correo
              <input
                name="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                required
              />
            </label>
            <label className="login-field">
              Contraseña
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                minLength={16}
                required
              />
            </label>
            <button
              className="login-submit"
              type="submit"
              disabled={loginPending}
            >
              {loginPending ? "Ingresando…" : "Ingresar"}
            </button>
          </form>
        </div>
      </section>
      <aside
        className="login-story"
        data-ui="login-story"
        aria-labelledby="login-story-title"
      >
        <Brand className="login-story__brand" inverse />
        <div className="login-story__content">
          <p className="login-story__eyebrow">
            Tu agente inteligente para WhatsApp
          </p>
          <h2 id="login-story-title">
            <span data-ui="login-story-heading-primary">Atendé mejor.</span>{" "}
            <span data-ui="login-story-heading-accent">
              Sin estar pendiente.
            </span>
          </h2>
          <p className="login-story__copy">
            Menos tiempo pendiente del teléfono. Más tiempo para dedicarle a
            tu negocio.
          </p>
        </div>
      </aside>
    </main>
  );
}
