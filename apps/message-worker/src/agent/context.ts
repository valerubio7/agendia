import {
  ToolConversationRequestSchema, TOOL_CONVERSATION_LIMITS, AGENT_SYSTEM_INSTRUCTIONS,
  type ToolConversationMessage,
} from "@agendia/domain";
import { REQUEST_BUDGET_BYTES, requestBytes } from "./limits.ts";
import { agentToolDefinitions } from "./tools.ts";
type Turn = { id: string; sequence: string; direction: string; processing_state: string; raw_text: string };
interface AgentSource {
  raw_text: string; sequence: string; profile: Record<string, string>; agent: Record<string, string>;
  currentGroup: { id: string; sequence: string; raw_text: string }[]; turns: Turn[];
  summaries: { covered_through: string; structured_summary: unknown }[];
}
const SUMMARY_KEYS = ["facts", "requests", "commitments", "preferences", "openItems"];
function boundedSummary(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5 && SUMMARY_KEYS.every(key => Array.isArray(record[key])
    && record[key].length <= 30 && record[key].every((item: unknown) => typeof item === "string" && item.length <= 1000))
    && JSON.stringify(value).length <= 6000;
}
function dataMessages(value: unknown, section: string): ToolConversationMessage[] {
  const serialized = JSON.stringify(value);
  if (serialized.length <= TOOL_CONVERSATION_LIMITS.messageCharacters) return [{ role: "user", content: serialized }];
  const chunks: string[] = [];
  for (let offset = 0; offset < serialized.length;) {
    let end = Math.min(offset + 2000, serialized.length);
    // Do not split a surrogate pair or change the source string while packing.
    if (end < serialized.length && /[\uD800-\uDBFF]/u.test(serialized[end - 1]!)) end--;
    chunks.push(serialized.slice(offset, end)); offset = end;
  }
  return chunks.map((text, index) => ({ role: "user", content: JSON.stringify({
    dataOnly: true, section, part: index + 1, total: chunks.length, text,
  }) }));
}
/** Build under the source lock. Current group is appended exactly once, in sequence order.
 * Required data is losslessly packed; only optional oldest history and then summary
 * may be dropped. Oversized required configuration/input fails before any provider call. */
export function buildAgentMessages(source: AgentSource, administratorSettings: string, now: string,
  runtime: unknown = null): ToolConversationMessage[] {
  const group = [...source.currentGroup].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const groupIds = new Set(group.map(turn => turn.id));
  const groupStart = Math.min(Number(source.sequence), ...group.map(turn => Number(turn.sequence)));
  const summary = source.summaries.find(row => Number(row.covered_through) < groupStart && boundedSummary(row.structured_summary));
  const settings = { agentSettings: source.agent, administratorSettings };
  const settingsMessages = dataMessages(settings, "settings");
  const metadata = { dataOnly: true, serverTime: now,
    business: { displayName: source.profile.display_name ?? "", description: source.profile.description ?? "", address: source.profile.address ?? "" },
    ...settings, summary: summary?.structured_summary ?? null, runtime };
  // Keep compact ordinary context in one message. Large settings retain all text
  // in labeled continuation data, without making any part a privileged system role.
  const separateSettings = JSON.stringify(metadata).length > TOOL_CONVERSATION_LIMITS.messageCharacters;
  const prefix = () => [{ role: "system" as const, content: AGENT_SYSTEM_INSTRUCTIONS },
    ...dataMessages(separateSettings ? { ...metadata, agentSettings: null, administratorSettings: null } : metadata, "context"),
    ...(separateSettings ? settingsMessages : [])];
  const history = source.turns.filter(turn => !groupIds.has(turn.id) && Number(turn.sequence) < groupStart
    && Number(turn.sequence) > Number(summary?.covered_through ?? 0)
    && (turn.direction === "inbound" || turn.processing_state === "sent"))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(-20);
  const recent: ToolConversationMessage[] = history.map(turn => turn.direction === "inbound"
    ? { role: "user", content: turn.raw_text.slice(0, 2000) || "[empty message]" }
    : { role: "assistant", content: turn.raw_text.slice(0, 2000) || "[empty message]", toolCalls: [] });
  const current = group.length ? group.map(turn => turn.raw_text).join("\n") : source.raw_text;
  const currentMessages: ToolConversationMessage[] = current.length <= TOOL_CONVERSATION_LIMITS.messageCharacters
    ? [{ role: "user", content: current }] : dataMessages({ text: current }, "currentInput");
  const assemble = () => [...prefix(), ...recent, ...currentMessages];
  const fits = (messages: ToolConversationMessage[]) => messages.length <= TOOL_CONVERSATION_LIMITS.messages
    && requestBytes(messages) <= REQUEST_BUDGET_BYTES;
  let messages = assemble();
  while (!fits(messages) && recent.length) { recent.shift(); messages = assemble(); }
  if (!fits(messages) && metadata.summary) { metadata.summary = null; messages = assemble(); }
  if (!fits(messages)) throw new Error("Agent required context exceeds native limits");
  ToolConversationRequestSchema.parse({ messages, tools: agentToolDefinitions, maxOutputCharacters: 4000, correlationId: "context" });
  return messages;
}
