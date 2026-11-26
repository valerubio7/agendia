import type { ReactNode } from "react";
import { PanelLayout } from "../../src/shell/panel-route";

export default function BusinessLayout({ children }: { children: ReactNode }) {
  return <PanelLayout variant="business">{children}</PanelLayout>;
}
