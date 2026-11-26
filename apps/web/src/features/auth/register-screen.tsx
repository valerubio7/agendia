"use client";

import { useRef, useState, type FormEvent, type FormEventHandler, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../api/api-client";
import { PanelBrand } from "../../components/panel-brand";
import "./register.css";

export function RegisterScreen({ pending, success = false, feedback, submitAction }: { pending: boolean; success?: boolean; feedback: ReactNode; submitAction: FormEventHandler<HTMLFormElement> }) {
  return <main className="register-screen" data-ui="register-screen">
    <PanelBrand dark />
    <section aria-labelledby="register-title">
      <header><h1 id="register-title">Solicitar acceso</h1><p>Completá los datos de tu negocio. Vas a poder ingresar cuando se apruebe tu solicitud.</p></header>
      {feedback}
      <form onSubmit={submitAction} aria-busy={pending}>
        <label>Nombre del negocio<input name="name" autoComplete="organization" required maxLength={160} pattern={".*\\S.*"} /></label>
        <label>Correo<input name="email" type="email" autoComplete="email" required /></label>
        <label>Contraseña<input name="password" type="password" autoComplete="new-password" minLength={16} required aria-describedby="register-password-help" /></label>
        <p id="register-password-help">Al menos 16 caracteres.</p>
        <label>Repetir contraseña<input name="passwordConfirmation" type="password" autoComplete="new-password" minLength={16} required /></label>
        <button disabled={pending || success} type="submit">{pending ? "Enviando…" : success ? "Solicitud enviada" : "Solicitar acceso"}</button>
      </form>
      <footer><a href="/login">Volver a iniciar sesión</a></footer>
    </section>
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
