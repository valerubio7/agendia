"use client";

import { usePathname } from "next/navigation";
import { createContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "../api/api-client";
import { AuthenticatedShell, PendingDestination, TerminalAuthenticatedState } from "./authenticated-shell";

// Route labels only: no controls, records or counts from an unverified session.
const destinations: Record<string, readonly [string, string, ...string[]] | undefined> = {
  "/inicio": ["Inicio", "Resumen del día", "Próximo turno", "Turnos de hoy"],
  "/turnos": ["Agenda", "Calendario", "Turnos del día", "Horarios libres"],
  "/profile": ["Negocio", "Información del negocio", "Datos del perfil", "Gestión del negocio"],
  "/clients": ["Clientes", "Directorio de clientes", "Contactos", "Historial de turnos"],
  "/services": ["Servicios", "Catálogo de servicios", "Categorías", "Servicios"],
  "/resources": ["Recursos", "Catálogo de recursos", "Disponibilidad", "Servicios asignados"],
  "/business-calendar": ["Horarios", "Calendario del negocio", "Horario semanal", "Cierres"],
  "/agent": ["Asistente IA", "Configuración del asistente", "Estilo", "Instrucciones del negocio"],
  "/whatsapp": ["WhatsApp", "Vinculación de WhatsApp", "Número del negocio", "Estado de la conexión"],
  "/solicitudes": ["Solicitudes pendientes", "Solicitudes de alta", "Negocio", "Fecha de solicitud"],
  "/businesses": ["Negocios", "Directorio de negocios", "Estado operativo", "Agente IA", "WhatsApp"],
  "/ajustes": ["Ajustes", "Tiempos de respuesta", "Configuración global"],
};

export const sameSession = (a: Session, b: Session) =>
  typeof a.sessionId === "string" && a.sessionId.length > 0 && a.sessionId === b.sessionId &&
  a.identityId === b.identityId && a.role === b.role && a.businessId === b.businessId;

type Snapshot = {
  state: "ready" | "loading" | "load-error" | "session-recovery" | "denied";
  session: Session | null;
  message: string;
  retry: () => void;
  logout: () => void;
  logoutPending: boolean;
};

export const PanelRoute = createContext<{
  report: (snapshot: Snapshot) => void;
  accepts: (session: Session) => boolean;
  visible: boolean;
} | null>(null);

export function PanelLayout({ variant, children }: { variant: "business" | "admin"; children: ReactNode }) {
  const pathname = usePathname();
  const owner = useRef<Session | null>(null);
  const [last, setLast] = useState<{ visit: symbol; snapshot: Snapshot; warm: boolean }>();
  const visit = useMemo(() => Symbol(pathname), [pathname]);
  const route = useMemo(() => ({
    accepts: (session: Session) => !owner.current || sameSession(owner.current, session),
    report: (snapshot: Snapshot) => {
      if (snapshot.state === "ready") owner.current = snapshot.session;
      setLast(previous => ({ visit, snapshot,
        warm: snapshot.state === "ready" || snapshot.state === "loading" && !!previous?.warm }));
    },
  }), [visit]);
  const current = last?.visit === visit ? last.snapshot : undefined;
  const state = current?.state ?? "loading";
  const ready = state === "ready";
  const showChrome = ready || state === "loading" && !!last?.warm;
  const [title, section, ...topics] = destinations[pathname] ?? ["Panel"];
  const destination = state === "loading" ? <PendingDestination {...{ title, section, topics }}
    className={variant === "admin" && showChrome ? "adm-app" : undefined} /> : null;

  return <>
    {!showChrome && (state === "loading" ? destination : <TerminalAuthenticatedState state={state}
      loginHref={variant === "admin" ? "/admin/login" : "/"}
      {...(current && { message: current.message, retryAction: current.retry })} />)}
    <div hidden={!showChrome} onClickCapture={event => {
      if (current?.logoutPending && event.target instanceof Element && event.target.closest("a[href]")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
      <AuthenticatedShell variant={variant} activeHref={pathname === "/inicio" ? "/turnos" : pathname}
        sectionPending={!ready} logoutPending={!!current?.logoutPending} logoutAction={() => {
          if (ready) current?.logout();
        }}>
        {showChrome && destination}
        <PanelRoute.Provider key={pathname} value={{ ...route, visible: ready }}>{children}</PanelRoute.Provider>
      </AuthenticatedShell>
    </div>
  </>;
}
