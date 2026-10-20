import { createElement } from "react";
import { LivePanel } from "../../shell/live-panel";
export const AdminView = () => createElement(LivePanel, { mode: "admin" });
