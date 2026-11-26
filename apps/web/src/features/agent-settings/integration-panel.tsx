"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useOutsideDismiss } from "../../components/dialog-dismiss";
import { focusIntegrationOnReturn, IntegrationBackdrop } from "../business-profile/profile-screen";
import "./integration-panel.css";

const paths = {
  spark: "m12 2 1.8 8.2L22 12l-8.2 1.8L12 22l-1.8-8.2L2 12l8.2-1.8z",
  message: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5A9 9 0 0 1 8 19l-5 2 1.7-5a8.5 8.5 0 1 1 16.3-4.5z",
  close: "m6 6 12 12M18 6 6 18",
  check: "m5 12 4 4L19 6",
};

export function IntegrationIcon({ name }: { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function IntegrationPanel({ kind, children, closeDisabled = false }: {
  kind: "agent" | "whatsapp";
  children: (dismiss: () => void) => ReactNode;
  closeDisabled?: boolean;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  function dismiss() {
    if (closeDisabled) return;
    focusIntegrationOnReturn(`/${kind}`);
    router.replace("/profile");
  }
  const backdrop = useOutsideDismiss(dismiss);

  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!panel?.open) panel?.showModal();
    close.current?.focus({ preventScroll: true });
    return () => panel?.close();
  }, []);

  return <>
    <IntegrationBackdrop />
    <dialog ref={dialog} className="integration-dialog" data-ui={`${kind}-screen`} aria-labelledby="integration-title" {...backdrop}
      onCancel={event => { event.preventDefault(); dismiss(); }}>
      <header className="integration-head">
        <span className="integration-icon"><IntegrationIcon name={kind === "agent" ? "spark" : "message"} /></span>
        <h2 id="integration-title">{kind === "agent" ? "Asistente IA" : "WhatsApp"}</h2>
        <button type="button" ref={close} className="integration-close" aria-label="Cerrar panel" disabled={closeDisabled} onClick={dismiss}><IntegrationIcon name="close" /></button>
      </header>
      {children(dismiss)}
    </dialog>
  </>;
}
