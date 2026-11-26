"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useOutsideDismiss } from "../../components/dialog-dismiss";
import { PanelBrand } from "../../components/panel-brand";
import { PanelLogout, type PanelLogoutProps } from "../../components/panel-logout";
import { AdminIcon } from "./admin-icons";
import "./admin.css";

const destinations = [
  ["/solicitudes", "Inicio", "home"], ["/businesses", "Negocios", "briefcase"], ["/ajustes", "Ajustes", "sliders"],
] as const;

export function AdminShell({ children, logout }: { children: ReactNode; logout: PanelLogoutProps }) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(true);
  const mobile = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const backdrop = useOutsideDismiss(() => mobile.current?.close());
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 921px)");
    const close = () => { if (desktop.matches) mobile.current?.close(); };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, []);
  const navigation = (drawer: boolean) => <>
    <nav aria-label="Navegación administrativa" data-ui={drawer ? undefined : "desktop-navigation"}>
      {destinations.map(([href, label, icon]) => <Link key={href} href={href} aria-label={label} title={label}
        aria-current={pathname === href ? "page" : undefined} {...(drawer ? { onClick: () => mobile.current?.close() } : {})}>
        <AdminIcon name={icon} /><span>{label}</span>
      </Link>)}
    </nav>
    <PanelLogout {...logout} collapsed={!drawer && !expanded}><span className="adm-role">ADMIN</span></PanelLogout>
  </>;
  return <div className="adm-shell" data-ui="authenticated-shell" data-variant="admin" data-expanded={expanded}>
    <aside className="adm-rail adm-desktop"><button className="adm-brand-button" type="button" aria-label={expanded ? "Contraer navegación" : "Expandir navegación"}
      aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><PanelBrand compact={!expanded} /></button>{navigation(false)}</aside>
    <header className="adm-mobile"><button ref={trigger} className="adm-brand-button" type="button" aria-label="Abrir navegación" aria-haspopup="dialog"
      onClick={() => mobile.current?.showModal()}><PanelBrand /></button></header>
    <dialog ref={mobile} className="adm-rail adm-drawer" aria-label="Menú de administración" data-ui="mobile-navigation" {...backdrop}
      onClose={() => trigger.current?.focus()}>
      <div><button className="adm-brand-button" type="button" aria-label="Cerrar navegación" onClick={() => mobile.current?.close()}><PanelBrand ariaHidden /></button>{navigation(true)}</div>
    </dialog>
    {children}
  </div>;
}
