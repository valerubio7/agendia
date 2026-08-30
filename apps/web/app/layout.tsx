import type { ReactNode } from "react";
import "./styles.css";
export const metadata = { title: "AgendIA", description: "Administración segura de asistentes para WhatsApp" };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="es"><body>{children}</body></html>; }
