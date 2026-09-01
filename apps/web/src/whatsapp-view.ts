import { createElement } from "react";
import { LivePanel } from "./live-panel";
export const WhatsAppView = () => createElement(LivePanel, { mode: "whatsapp" });
