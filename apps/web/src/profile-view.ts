import { createElement } from "react";
import { LivePanel } from "./live-panel";
export const ProfileView = () => createElement(LivePanel, { mode: "profile" });
