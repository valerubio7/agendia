import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useOutsideDismiss } from "../../components/dialog-dismiss";

const paths = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M8 14h3M8 18h6" /></>,
  pencil: <path d="m4 20 4.3-.9L20 7.4a2.1 2.1 0 0 0-3-3L5.3 16.1zM14.8 6.6l3 3" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m4 12 5 5L20 6" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  trash: <path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3" />,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 11v5m0-8h.01" /></>,
};

export function CalendarIcon({ name }: { name: keyof typeof paths }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function CalendarDialog({ title, icon, pending, onDismiss, children }: {
  title: string; icon: "clock" | "calendar"; pending: boolean; onDismiss: () => void; children: ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const surface = dialog.current!;
    surface.showModal();
    return () => surface.close();
  }, []);
  const dismiss = () => { if (!pending) onDismiss(); };
  const backdrop = useOutsideDismiss(dismiss);
  return <dialog ref={dialog} className="hours-editor" aria-labelledby={titleId} {...backdrop}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className="hours-dialog-head">
      <span className="hours-dialog-icon"><CalendarIcon name={icon} /></span>
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="hours-dialog-close" aria-label="Cerrar" disabled={pending} onClick={onDismiss}>
        <CalendarIcon name="x" />
      </button>
    </header>
    {children}
  </dialog>;
}
