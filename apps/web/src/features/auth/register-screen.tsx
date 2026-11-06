"use client";

import { useRef, useState, type FormEvent, type FormEventHandler, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../api/api-client";
import { Brand } from "../../components/brand";
import { AuthStory } from "./login-screen";

export function RegisterScreen({ pending, success = false, feedback, submitAction }: { pending: boolean; success?: boolean; feedback: ReactNode; submitAction: FormEventHandler<HTMLFormElement> }) {
  return <main className="login-frame" data-ui="login-frame">
    <section className="login-form-panel" data-ui="login-form-panel" aria-labelledby="register-title"><div className="login-card">
      <Brand /><h1 id="register-title">Solicitar acceso</h1><p className="login-welcome">Completá tus datos para solicitar acceso.</p>
      {feedback}
      <form onSubmit={submitAction} aria-busy={pending}>
        <label className="login-field">Nombre del negocio<input name="name" required maxLength={160} pattern={".*\\S.*"} /></label>
        <label className="login-field">Correo<input name="email" type="email" autoComplete="email" required /></label>
        <label className="login-field">Contraseña<input name="password" type="password" autoComplete="new-password" minLength={16} required /></label>
        <label className="login-field">Repetir contraseña<input name="passwordConfirmation" type="password" autoComplete="new-password" minLength={16} required /></label>
        <button className="login-submit" disabled={pending || success} type="submit">{pending ? "Enviando…" : success ? "Solicitud enviada" : "Solicitar acceso"}</button>
      </form><p><a href="/login">Volver a iniciar sesión</a></p>
    </div></section>
    <AuthStory />
  </main>;
}

export function Register() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const inFlight = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || success) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password"));
    if (password !== String(values.get("passwordConfirmation"))) {
      setMessage("Las contraseñas no coinciden.");
      return;
    }
    inFlight.current = true; setPending(true); setMessage("");
    try {
      await api.register({ name: String(values.get("name")), email: String(values.get("email")), password });
      form.reset(); setSuccess(true); router.replace("/login?registro=pendiente");
    } catch (error) {
      setMessage(api.registrationErrorMessage(error));
    } finally { inFlight.current = false; setPending(false); }
  };
  return <RegisterScreen pending={pending} success={success} feedback={message && <p role={success ? "status" : "alert"}>{message}</p>} submitAction={submit} />;
}
