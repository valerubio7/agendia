"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { BrandedName } from "../components/brand";
import { AdminShell } from "../features/administration/admin-shell";
import { BusinessNavigationShell } from "./business-navigation";

type ShellVariant = "business" | "admin";
type TerminalState = "loading" | "session-recovery" | "denied" | "load-error";

type AuthenticatedShellProps = {
  variant: ShellVariant;
  activeHref: string;
  children: ReactNode;
  sectionPending?: boolean;
  logoutPending: boolean;
  logoutAction: () => void;
};

type TerminalAuthenticatedStateProps = {
  loginHref?: string;
  state: TerminalState;
  message?: string;
  retryAction?: () => void;
  title?: string;
};

export function AuthenticatedShell({
  variant,
  activeHref,
  children,
  sectionPending = false,
  logoutPending,
  logoutAction,
}: AuthenticatedShellProps) {
  const logout = { disabled: sectionPending || logoutPending, signingOut: logoutPending, onClick: logoutAction };
  if (variant === "business") {
    return <BusinessNavigationShell activeHref={activeHref} logout={logout}>{children}</BusinessNavigationShell>;
  }
  return <AdminShell logout={logout}>{children}</AdminShell>;
}

export function PendingDestination({ title, section, topics, className = "" }: {
  title: string;
  section?: string | undefined;
  topics?: readonly string[];
  className?: string | undefined;
}) {
  const heading = useId();
  const sectionHeading = useId();
  return <main className={`panel-destination ${className}`} aria-labelledby={heading} aria-busy="true">
    <header><h1 id={heading}>{title}</h1></header>
    {section && <section aria-labelledby={sectionHeading}>
      <h2 id={sectionHeading}>{section}</h2>
      <ul>{topics?.map(topic => <li key={topic}>{topic}</li>)}</ul>
    </section>}
  </main>;
}

export function TerminalAuthenticatedState({
  loginHref = "/",
  state,
  message,
  retryAction,
  title = "Iniciar sesión",
}: TerminalAuthenticatedStateProps) {
  if (state === "loading") return <PendingDestination title={title} />;

  const heading =
    state === "session-recovery"
      ? "Tu sesión no está disponible"
      : state === "denied"
        ? "No tenés acceso a este panel"
        : "No pudimos cargar el panel";

  return (
    <main className="authenticated-terminal" data-state={state}>
      <BrandedName />
      <h1>{heading}</h1>
      {message && <p role="alert">{message}</p>}
      <div className="authenticated-terminal__actions">
        <Link href={loginHref}>Ir a iniciar sesión</Link>
        {state === "load-error" && retryAction && (
          <button type="button" onClick={retryAction}>
            Volver a intentar
          </button>
        )}
      </div>
    </main>
  );
}
