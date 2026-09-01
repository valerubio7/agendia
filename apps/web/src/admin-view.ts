import { createElement } from "react";
import { LivePanel } from "./live-panel";
export const AdminView = () => createElement(LivePanel, { mode: "admin" });
