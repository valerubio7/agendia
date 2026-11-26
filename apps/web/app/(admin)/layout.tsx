import type { ReactNode } from "react";
import { PanelLayout } from "../../src/shell/panel-route";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <PanelLayout variant="admin">{children}</PanelLayout>;
}
