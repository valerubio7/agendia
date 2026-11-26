import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type FormEventHandler, type ReactNode, type RefObject } from "react";
import { api, type Profile } from "../../api/api-client";
import { useOutsideDismiss } from "../../components/dialog-dismiss";
import { resolveWhatsAppStatusView } from "../whatsapp/whatsapp-status";
import "./profile-screen.css";

type ProfileScreenProps = {
  profile: Partial<Profile>;
  feedback: ReactNode;
  savePending: boolean;
  submitAction: FormEventHandler<HTMLFormElement>;
};

const fields = [
  { name: "displayName", label: "Nombre comercial", hint: "Es el nombre que verán tus clientes.", maxLength: 160, required: true },
  { name: "description", label: "Descripción", hint: "Contá qué ofrece tu negocio.", maxLength: 4000, multiline: true },
  { name: "address", label: "Dirección", hint: "Calle o zona de atención.", maxLength: 500 },
] as const;

const icons = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  map: "m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15",
  spark: "m12 2 1.8 8.2L22 12l-8.2 1.8L12 22l-1.8-8.2L2 12l8.2-1.8z",
  message: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5A9 9 0 0 1 8 19l-5 2 1.7-5a8.5 8.5 0 1 1 16.3-4.5z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 4.5a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 1 1 8 0Z",
  grid: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z",
  briefcase: "M5 7h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18",
  clock: "M21 12a9 9 0 1 0-18 0 9 9 0 1 0 18 0ZM12 7v5l3 2",
  cross: "m6 6 12 12M18 6 6 18",
  check: "m5 12 4 4L19 6",
};

function Icon({ name }: { name: keyof typeof icons }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

const shortcuts = [
  ["/clients", "Clientes", "users"], ["/services", "Servicios", "grid"],
  ["/resources", "Recursos", "briefcase"], ["/business-calendar", "Horarios", "clock"],
] as const;

type IntegrationStatus = { label: string; active?: boolean };
const loading = { label: "Consultando estado…" };
const unavailable = { label: "Estado no disponible" };

let returnFocus: "/agent" | "/whatsapp" | undefined;

export function focusIntegrationOnReturn(href: typeof returnFocus) {
  returnFocus = href;
}

function ProfileDestinations({ restoreFocus }: { restoreFocus: boolean }) {
  const integrations = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!restoreFocus || !returnFocus) return;
    integrations.current?.querySelector<HTMLElement>(`a[href="${returnFocus}"]`)?.focus({ preventScroll: true });
    returnFocus = undefined;
  }, [restoreFocus]);
  const [agent, setAgent] = useState<IntegrationStatus>(loading);
  const [whatsapp, setWhatsApp] = useState<IntegrationStatus>(loading);

  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted;
    void api.agent().then(({ active }) => {
      if (current()) setAgent(typeof active === "boolean" ? { label: active ? "Asistente activo" : "Asistente pausado", active } : unavailable);
    }, () => { if (current()) setAgent(unavailable); });
    void api.whatsappStatus(controller.signal).then(({ status }) => {
      if (current()) setWhatsApp({ label: resolveWhatsAppStatusView(status).label, active: status === "connected" });
    }, () => { if (current()) setWhatsApp(unavailable); });
    return () => controller.abort();
  }, []);

  return <>
    <div ref={integrations} className="negocio-integrations">
      {([
        ["/agent", "Asistente IA", "spark", agent],
        ["/whatsapp", "WhatsApp", "message", whatsapp],
      ] as const).map(([href, label, icon, status]) => <Link key={href} href={href} className="negocio-integration" aria-haspopup="dialog" aria-labelledby={`negocio-title-${icon}`} aria-describedby={`negocio-status-${icon}`}>
        <span className="negocio-integration__top"><span><Icon name={icon} /></span><Icon name="arrow" /></span>
        <span className="negocio-integration__info">
          <strong id={`negocio-title-${icon}`}>{label}</strong>
          <span id={`negocio-status-${icon}`} className="negocio-integration__status" data-active={status.active}>{status.label}</span>
        </span>
      </Link>)}
    </div>
    <div className="negocio-shortcuts">
      {shortcuts.map(([href, label, icon]) => <Link key={href} href={href}>
        <span><Icon name={icon} /></span>{label}
      </Link>)}
    </div>
  </>;
}

function ProfileHub({ profile, edit }: {
  profile: Partial<Profile> | null;
  edit?: { ref: RefObject<HTMLButtonElement | null>; open: () => void };
}) {
  return (
      <nav className="negocio-grid" aria-label="Gestión del negocio">
        <section className="negocio-card">
          <div className="negocio-card__copy">
            <h1>{profile?.displayName || "Negocio"}</h1>
            {profile?.description && <p>{profile.description}</p>}
            {profile?.address && <div className="negocio-card__address"><Icon name="map" /><span>{profile.address}</span></div>}
          </div>
          {edit && <button ref={edit.ref} className="negocio-card__edit" type="button" aria-haspopup="dialog" aria-label="Editar información del negocio" onClick={edit.open}><Icon name="arrow" /></button>}
        </section>
        <ProfileDestinations restoreFocus={!!edit} />
      </nav>
  );
}

export function IntegrationBackdrop() {
  const [profile, setProfile] = useState<Partial<Profile> | null>(null);
  useEffect(() => {
    let mounted = true;
    void api.profile().then(result => { if (mounted) setProfile(result); }, () => {});
    return () => { mounted = false; };
  }, []);
  return <main className="negocio"><ProfileHub profile={profile} /></main>;
}

export function ProfileScreen({ profile, feedback, savePending, submitAction }: ProfileScreenProps) {
  const [editing, setEditing] = useState(false);
  const [announcedSave, setAnnouncedSave] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const submitted = useRef<Partial<Profile> | null>(null);

  function closeEditor() {
    dialog.current?.close();
    submitted.current = null;
    setEditing(false);
    edit.current?.focus();
  }

  useLayoutEffect(() => {
    if (editing && !dialog.current?.open) {
      dialog.current?.showModal();
      close.current?.focus();
    }
  }, [editing]);

  useLayoutEffect(() => {
    // LivePanel replaces the saved snapshot only after a confirmed PUT.
    if (submitted.current && submitted.current !== profile) {
      closeEditor();
      setAnnouncedSave(true);
    }
  }, [profile]);

  const dismiss = () => { if (!savePending) closeEditor(); };
  const backdrop = useOutsideDismiss(dismiss);
  return (
    <main className="negocio" data-ui="profile-screen">
      <ProfileHub profile={profile} edit={{ ref: edit, open: () => { setAnnouncedSave(false); setEditing(true); } }} />
      {!editing && announcedSave && <div className="profile-feedback negocio-feedback">{feedback}</div>}
      <dialog ref={dialog} className="negocio-dialog" aria-labelledby="negocio-dialog-title" {...backdrop}
        onCancel={event => { event.preventDefault(); dismiss(); }}>
        {editing && <form id="business-profile-form" aria-label="Perfil del negocio" aria-busy={savePending} onSubmit={event => {
          submitted.current = profile;
          submitAction(event);
        }}>
          <header className="negocio-dialog__head">
            <span className="negocio-dialog__icon"><Icon name="briefcase" /></span>
            <h2 id="negocio-dialog-title">Información del negocio</h2>
            <button ref={close} className="negocio-dialog__close" type="button" aria-label="Cerrar panel" disabled={savePending} onClick={closeEditor}><Icon name="cross" /></button>
          </header>
          <div className="negocio-dialog__body">
            <div className="negocio-dialog__rule" />
            {fields.map(({ name, label, hint, maxLength, ...kind }) => {
              const id = `profile-${name}`;
              const field = { id, name, maxLength, defaultValue: profile[name] ?? "", "aria-describedby": `${id}-hint`, readOnly: savePending };
              return <div key={name} className="negocio-field">
                <label htmlFor={id}>{label}</label>
                {"multiline" in kind ? <textarea {...field} rows={4} /> : <input {...field} type="text" required={"required" in kind} />}
                <small id={`${id}-hint`}>{hint} Hasta {maxLength.toLocaleString("es-AR")} caracteres.</small>
              </div>;
            })}
            {submitted.current && <div className="profile-feedback negocio-feedback">{feedback}</div>}
          </div>
          <footer className="negocio-dialog__footer" data-ui="profile-save-panel">
            <button type="button" disabled={savePending} onClick={closeEditor}>Cancelar</button>
            <button type="submit" form="business-profile-form" disabled={savePending}><Icon name="check" />{savePending ? "Guardando…" : "Guardar cambios"}</button>
          </footer>
        </form>}
      </dialog>
    </main>
  );
}
