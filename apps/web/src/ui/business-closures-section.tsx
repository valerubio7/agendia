import { useEffect, useRef } from "react";
import type { BusinessClosure } from "../api-client";
import { formatArgentinaClosureDate, formatArgentinaClosureInstant } from "./argentina-closure-time";

export type ClosureReadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; closures: BusinessClosure[] };

export function BusinessClosuresSection({ state, retryAction }: {
  state: ClosureReadState; retryAction: () => Promise<void>;
}) {
  const retryButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (state.status === "loading" || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = retryButton.current ?? heading.current;
    if (target?.isConnected) target.focus();
  }, [state]);
  return <section className="services-empty" aria-labelledby="business-closures-title" aria-busy={state.status === "loading"}>
    <h2 ref={heading} id="business-closures-title" tabIndex={-1}>Cierres del negocio</h2>
    <p>Se aplican a todo el negocio. Las fechas y horas se muestran en Argentina.</p>
    {state.status === "loading" && <p role="status">Cargando cierres…</p>}
    {(state.status === "error" || state.status === "loading") && <>
      {state.status === "error" && <p role="alert">{state.message}</p>}
      <button ref={retryButton} type="button" disabled={state.status === "loading"} onClick={() => {
        restoreFocus.current = true;
        void retryAction();
      }}>Volver a cargar cierres</button>
    </>}
    {state.status === "ready" && (state.closures.length === 0 ?
      <p>No hay cierres guardados. El horario semanal sigue siendo la referencia de atención.</p> :
      <ul className="services-list">
        {state.closures.map(closure => <li key={closure.id} className="services-item" data-closure-id={closure.id}>
          {closure.kind === "date" ? <p>Día completo: {formatArgentinaClosureDate(closure.date)}</p> : <>
            <p>Desde: {formatArgentinaClosureInstant(closure.start)}</p>
            <p>Hasta: {formatArgentinaClosureInstant(closure.end)}</p>
          </>}
        </li>)}
      </ul>)}
  </section>;
}
