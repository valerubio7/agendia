"use client";

import { useRef, useState, type FormEvent, type FormEventHandler, type ReactNode } from "react";
import { api, ApiError } from "../../api/api-client";
import { Brand } from "../../components/brand";

export function RegisterScreen({ pending, success = false, feedback, submitAction }: { pending: boolean; success?: boolean; feedback: ReactNode; submitAction: FormEventHandler<HTMLFormElement> }) {
  return <main className="login-frame"><section className="login-form-panel"><div className="login-card">
    <Brand /><h1>Solicitar acceso</h1><p className="login-welcome">Completá tus datos para solicitar acceso.</p>
    {feedback}
    <form onSubmit={submitAction} aria-busy={pending}>
      <label className="login-field">Nombre del negocio<input name="name" required maxLength={160} pattern={".*\\S.*"} /></label>
      <label className="login-field">Correo<input name="email" type="email" autoComplete="email" required /></label>
      <label className="login-field">Contraseña<input name="password" type="password" autoComplete="new-password" minLength={16} required /></label>
      <button className="login-submit" disabled={pending || success} type="submit">{pending ? "Enviando…" : success ? "Solicitud enviada" : "Solicitar acceso"}</button>
    </form><p><a href="/login">Volver a iniciar sesión</a></p>
  </div></section></main>;
}

export function Register() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const inFlight = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || success) return;
    inFlight.current = true; setPending(true); setMessage("");
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await api.register({ name: String(values.get("name")), email: String(values.get("email")), password: String(values.get("password")) });
      form.reset(); setSuccess(true); setMessage("Solicitud enviada. Esperá la aprobación antes de iniciar sesión.");
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 409 ? "Este correo ya está registrado." : error instanceof ApiError && error.status === 429 ? "Demasiados intentos. Intentá nuevamente más tarde." : api.errorMessage(error));
    } finally { inFlight.current = false; setPending(false); }
  };
  return <RegisterScreen pending={pending} success={success} feedback={message && <p role={success ? "status" : "alert"}>{message}</p>} submitAction={submit} />;
}
