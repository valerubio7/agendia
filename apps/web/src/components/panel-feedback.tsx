"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./panel-feedback.css";

export function PanelInlineError({ message }: { message: string }) {
  return <div className="turno-error" role="alert">{message}</div>;
}

export function PanelToast({ message, error, dialog }: { message: string; error: boolean; dialog: HTMLDialogElement | null }) {
  const area = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const [visible, setVisible] = useState(true);
  useLayoutEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 4000);
    return () => window.clearTimeout(timer);
  }, []);
  useLayoutEffect(() => {
    const node = area.current;
    // Modal siblings are inert. Put the popover inside the dialog but show it after showModal().
    queueMicrotask(() => {
      if (!node || node !== area.current || node.matches(":popover-open")) return;
      if (shown.current) node.dataset.relocated = "";
      node.showPopover();
      shown.current = true;
    });
  }, [dialog]);

  if (!visible) return null;
  const toast = <div ref={area} className="toast-area panel-toast" popover="manual" role="status">
    <div className="toast" data-error={error || undefined}>
      <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
        <path d={error ? "m12 3 10 18H2zM12 9v5m0 4h.01" : "m4 12 5 5L20 6"} />
      </svg>{" "}{message}
    </div>
  </div>;
  return dialog ? createPortal(toast, dialog) : toast;
}
