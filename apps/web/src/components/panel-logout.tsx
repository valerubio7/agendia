import type { ReactNode } from "react";
import { AdminIcon } from "../features/administration/admin-icons";
import "./panel-logout.css";

export type PanelLogoutProps = {
  disabled: boolean;
  signingOut: boolean;
  onClick: () => void;
};

export function PanelLogout({ disabled, signingOut, onClick, collapsed, children }: PanelLogoutProps & {
  collapsed?: boolean;
  children?: ReactNode;
}) {
  const label = signingOut ? "Cerrando sesión…" : "Cerrar sesión";
  return <footer className="panel-logout" data-collapsed={collapsed || undefined}>
    {children}
    <button className="panel-logout__button" type="button" title="Cerrar sesión" aria-label={label} disabled={disabled} onClick={onClick}>
      <AdminIcon name="logout" /><span>{label}</span>
    </button>
  </footer>;
}
