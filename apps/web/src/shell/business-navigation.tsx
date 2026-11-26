"use client";

import Link, { type LinkProps } from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState, type ReactNode } from "react";
import { useOutsideDismiss } from "../components/dialog-dismiss";
import { PanelBrand } from "../components/panel-brand";
import { PanelLogout, type PanelLogoutProps } from "../components/panel-logout";
import { FloatingTurnos } from "../features/appointments/turnos-screen";
import "./business-navigation.css";

const hubHref = "/profile";
const primary = [
  { href: "/inicio", label: "Inicio", icon: "m3 10 9-7 9 7v11H3zM9 21v-8h6v8" },
  { href: "/turnos", label: "Agenda", icon: "M3 5h18v16H3zM8 3v4m8-4v4M3 10h18m-13 5h3m-3 3h6" },
  { href: hubHref, label: "Negocio", icon: "M3 7h18v14H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" },
];

const sections = [
  { href: "/clients", label: "Clientes" },
  { href: "/services", label: "Servicios" },
  { href: "/resources", label: "Recursos" },
  { href: "/business-calendar", label: "Horarios" },
  { href: "/agent", label: "Agente" },
  { href: "/whatsapp", label: "WhatsApp" },
];

function NavIcon({ path }: { path: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

export function BusinessNavigationShell({ activeHref, logout, children }: {
  activeHref: string; logout: PanelLogoutProps; children: ReactNode;
}) {
  const pathname = usePathname();
  const home = activeHref === "/turnos" && pathname === "/inicio";
  const currentHref = home ? "/inicio" : activeHref;
  const section = sections.find(({ href }) => href === currentHref);
  const [expanded, setExpanded] = useState(true);
  const railId = useId();
  const summary = useRef<HTMLElement>(null);
  const drawer = useRef<HTMLDivElement>(null);

  function closeMenu() {
    const trigger = summary.current;
    if (trigger?.parentElement instanceof HTMLDetailsElement) trigger.parentElement.open = false;
    trigger?.focus();
  }
  const backdrop = useOutsideDismiss(closeMenu, () => drawer.current);

  const navigation = (mobile: boolean) => <nav id={mobile ? undefined : railId}
    className="business-shell__primary" data-ui={mobile ? undefined : "desktop-navigation"}
    aria-label={mobile ? "Navegación móvil del negocio" : "Navegación del negocio"}>
    {primary.map(({ href, label, icon }) => <Link key={href} href={href} aria-label={label} title={label}
      aria-current={href === currentHref ? "page" : href === hubHref && section ? "location" : undefined}
      {...(mobile ? { onNavigate: (event => {
        if (href === currentHref) event.preventDefault();
        closeMenu();
      }) satisfies NonNullable<LinkProps["onNavigate"]> } : {})}>
      <NavIcon path={icon} />
      <span>{label}</span>
    </Link>)}
  </nav>;

  return <div className="authenticated-shell business-shell" data-ui="authenticated-shell" data-variant="business"
    data-section={home ? "inicio" : undefined} data-rail={expanded ? "expanded" : "collapsed"}>
    <aside className="business-shell__rail business-shell__panel">
      <button type="button" className="business-shell__toggle" title="agendIA"
        aria-label={expanded ? "Contraer navegación" : "Expandir navegación"} aria-expanded={expanded}
        aria-controls={railId} onClick={() => setExpanded(value => !value)}>
        <PanelBrand ariaHidden compact={!expanded} />
      </button>
      {navigation(false)}
      <PanelLogout {...logout} collapsed={!expanded} />
    </aside>
    <header className="business-shell__header">
      <details data-ui="mobile-navigation" onKeyDown={event => {
        if (!event.currentTarget.open) return;
        if (event.key === "Escape") {
          event.stopPropagation();
          closeMenu();
        } else if (event.key === "Tab") {
          // The scrim blocks the workspace; keep keyboard traversal in the drawer too.
          const last = Array.from(drawer.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") ?? []).at(-1);
          const next = event.shiftKey && event.target === summary.current ? last
            : !event.shiftKey && event.target === last ? summary.current : null;
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }
      }}>
        <summary ref={summary} className="business-shell__toggle" aria-label="Menú">
          <span className="business-shell__menu-label">Menú</span><PanelBrand ariaHidden />
        </summary>
        <div className="business-shell__scrim" aria-hidden="true" {...backdrop} />
        <div ref={drawer} className="business-shell__drawer business-shell__panel">
          {navigation(true)}
          <PanelLogout {...logout} />
        </div>
      </details>
    </header>
    <section className="authenticated-shell__workspace">
      {section && <nav className="business-shell__breadcrumb" aria-label="Ruta de navegación">
        <Link href={hubHref}><NavIcon path="m15 18-6-6 6-6" />Negocio</Link>
        <span aria-hidden="true">/</span>
        <strong aria-current="page">{section.label}</strong>
      </nav>}
      <div className="authenticated-shell__content">
        {activeHref === "/turnos" ? children : <FloatingTurnos key={pathname} disabled={logout.disabled}>
          {children}
        </FloatingTurnos>}
      </div>
    </section>
  </div>;
}
