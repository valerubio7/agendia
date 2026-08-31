"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Brand, BrandedName } from "./brand";

type ShellVariant = "business" | "admin";
type NavigationItem = { href: string; label: string };
type TerminalState = "loading" | "session-recovery" | "denied" | "load-error";

type AuthenticatedShellProps = {
  variant: ShellVariant;
  activeHref: string;
  children: ReactNode;
  logoutPending: boolean;
  logoutAction: () => void;
};

type TerminalAuthenticatedStateProps = {
  state: TerminalState;
  message?: string;
  retryAction?: () => void;
};

type NavigationConfiguration = {
  desktopLabel: string;
  mobileLabel: string;
  links: readonly NavigationItem[];
};

const navigation: Record<ShellVariant, NavigationConfiguration> = {
  business: {
    desktopLabel: "Navegación del negocio",
    mobileLabel: "Navegación móvil del negocio",
    links: [
      { href: "/profile", label: "Perfil" },
      { href: "/assistant", label: "Asistente" },
      { href: "/whatsapp", label: "WhatsApp" },
    ],
  },
  admin: {
    desktopLabel: "Navegación administrativa",
    mobileLabel: "Navegación móvil administrativa",
    links: [{ href: "/businesses", label: "Negocios" }],
  },
};

function NavigationLinks({
  variant,
  activeHref,
}: Pick<AuthenticatedShellProps, "variant" | "activeHref">) {
  return navigation[variant].links.map((link) => (
    <Link
      key={link.href}
      href={link.href}
      aria-current={activeHref === link.href ? "page" : undefined}
    >
      {link.label}
    </Link>
  ));
}

function LogoutButton({
  pending,
  logoutAction,
}: {
  pending: boolean;
  logoutAction: () => void;
}) {
  return (
    <button type="button" disabled={pending} onClick={logoutAction}>
      {pending ? "Cerrando sesión…" : "Cerrar sesión"}
    </button>
  );
}

export function AuthenticatedShell({
  variant,
  activeHref,
  children,
  logoutPending,
  logoutAction,
}: AuthenticatedShellProps) {
  const configuration = navigation[variant];
  const currentSection = configuration.links.find(
    (link) => link.href === activeHref,
  )?.label;

  return (
    <div
      className="authenticated-shell"
      data-ui="authenticated-shell"
      data-variant={variant}
    >
      <aside className="authenticated-shell__sidebar">
        <Brand inverse />
        <nav
          className="authenticated-shell__navigation"
          data-ui="desktop-navigation"
          aria-label={configuration.desktopLabel}
        >
          <NavigationLinks variant={variant} activeHref={activeHref} />
        </nav>
        <LogoutButton pending={logoutPending} logoutAction={logoutAction} />
      </aside>

      <section className="authenticated-shell__workspace">
        <header className="authenticated-shell__topbar">
          <BrandedName className="authenticated-shell__mobile-brand" />
          <p className="authenticated-shell__section">
            <span>Sección actual</span>
            <strong>{currentSection}</strong>
          </p>
          <details data-ui="mobile-navigation">
            <summary aria-label="Menú">Menú</summary>
            <div className="authenticated-shell__mobile-menu">
              <nav aria-label={configuration.mobileLabel}>
                <NavigationLinks variant={variant} activeHref={activeHref} />
              </nav>
              <LogoutButton
                pending={logoutPending}
                logoutAction={logoutAction}
              />
            </div>
          </details>
        </header>
        <div className="authenticated-shell__content">{children}</div>
      </section>
    </div>
  );
}

export function TerminalAuthenticatedState({
  state,
  message,
  retryAction,
}: TerminalAuthenticatedStateProps) {
  if (state === "loading")
    return (
      <main className="authenticated-terminal" data-state="loading">
        <p role="status">Cargando panel…</p>
      </main>
    );

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
        <Link href="/">Ir a iniciar sesión</Link>
        {state === "load-error" && retryAction && (
          <button type="button" onClick={retryAction}>
            Volver a intentar
          </button>
        )}
      </div>
    </main>
  );
}
