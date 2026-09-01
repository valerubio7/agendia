import { createElement } from "react";
import { LivePanel } from "./live-panel";
export const AssistantView = () => createElement(LivePanel, { mode: "assistant" });
