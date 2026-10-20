import type { SocketFactory } from "@agendia/whatsapp-baileys";
import type { ReceptionistToolCommand, ReceptionistToolResult } from "../../../apps/message-worker/src/agent/tools.ts";

type SendOutcome = "ack" | "rejected" | "crash";
class DeterministicSocket {
  readonly ready: Promise<void>;
  readonly user: { id: string };
  ended = false;
  private resolveReady!: () => void;
  private qrDelivery?: Promise<void>;
  private opening?: Promise<void>;
  private openTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Map<
    string,
    (value: Record<string, unknown>) => unknown
  >();
  constructor(
    private readonly index: number,
    private readonly acks: Array<{
      socket: number;
      jid: string;
      text: string;
      providerMessageId: string;
    }>,
    private readonly send: () => SendOutcome,
    private readonly held: boolean,
  ) {
    this.user = { id: `1555000000${index}:1@s.whatsapp.net` };
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
  readonly ev = {
    on: (
      name: string,
      listener: (value: Record<string, unknown>) => unknown,
    ) => {
      if (this.ended) return;
      this.listeners.set(name, listener);
      if (name !== "connection.update" || this.qrDelivery || this.ended) return;
      this.qrDelivery = new Promise<void>((resolve, reject) => {
        queueMicrotask(async () => {
          try {
            if (!this.ended) await listener({ qr: `deterministic-qr-${this.index}` });
            if (!this.ended && !this.held && !this.opening) {
              this.openTimer = setTimeout(() => this.open(), 750);
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    },
  };
  open(): Promise<void> {
    if (this.ended) return Promise.reject(new Error(`socket ended: ${this.index}`));
    if (!this.qrDelivery) return Promise.reject(new Error(`socket listener unavailable: ${this.index}`));
    if (!this.opening) {
      if (this.openTimer !== undefined) clearTimeout(this.openTimer);
      this.opening = (async () => {
        await this.qrDelivery;
        if (this.ended) throw new Error(`socket ended: ${this.index}`);
        await this.listeners.get("connection.update")!({ connection: "open" });
        if (this.ended) throw new Error(`socket ended: ${this.index}`);
        this.resolveReady();
      })();
    }
    return this.opening;
  }
  async emit(name: string, value: Record<string, unknown>) {
    if (this.ended) throw new Error(`socket ended: ${this.index}`);
    return this.listeners.get(name)?.(value);
  }
  async sendMessage(jid: string, content: { text: string }) {
    if (!jid || !jid.endsWith("@s.whatsapp.net"))
      throw Object.assign(new Error("invalid recipient"), {
        code: "WA_REJECTED",
      });
    const outcome = this.send();
    if (outcome === "crash") throw new Error("socket lost after send started");
    if (outcome === "rejected")
      throw Object.assign(new Error("provider rejected message"), {
        code: "WA_REJECTED",
      });
    const providerMessageId = `ack-${this.acks.length + 1}`;
    this.acks.push({
      socket: this.index,
      jid,
      text: content.text,
      providerMessageId,
    });
    return { key: { id: providerMessageId } };
  }
  transientClose() {
    if (!this.ended) void this.listeners.get("connection.update")?.({ connection: "close" });
  }
  end() {
    this.ended = true;
    if (this.openTimer !== undefined) clearTimeout(this.openTimer);
    this.listeners.clear();
  }
}

export class DeterministicBaileysSystemDouble {
  readonly acks: Array<{
    socket: number;
    jid: string;
    text: string;
    providerMessageId: string;
  }> = [];
  readonly sockets: DeterministicSocket[] = [];
  readonly ingressIds: string[] = [];
  private readonly heldSockets = new Set<number>();
  holdSocket(index: number) {
    if (!Number.isInteger(index) || index <= this.sockets.length)
      throw new Error(`new socket index required: ${index}`);
    this.heldSockets.add(index);
  }
  async openSocket(index: number) {
    const socket = this.sockets[index - 1];
    if (!socket) throw new Error(`socket unavailable: ${index}`);
    await socket.open();
  }
  active = false;
  next: SendOutcome = "ack";
  sendAttempts = 0;
  private take = () => {
    this.sendAttempts++;
    const value = this.next;
    this.next = "ack";
    return value;
  };
  readonly factory: SocketFactory = () => {
    if (!this.active) throw new Error("Baileys double is not ready");
    const socket = new DeterministicSocket(
      this.sockets.length + 1,
      this.acks,
      this.take,
      this.heldSockets.delete(this.sockets.length + 1),
    );
    this.sockets.push(socket);
    return socket;
  };
  transientClose() {
    this.sockets.findLast((socket) => !socket.ended)?.transientClose();
  }
  async emit(linkedNumber: string, message: Record<string, unknown>) {
    const socket = this.sockets.findLast(
      (s) => !s.ended && s.user.id.startsWith(`${linkedNumber}:`),
    );
    if (!socket) throw new Error(`socket unavailable: ${linkedNumber}`);
    await socket.emit("messages.upsert", { type: "notify", messages: [message] });
    const id = (message.key as { id?: string } | undefined)?.id;
    if (id) this.ingressIds.push(id);
  }
  async rejectsRecipient(jid: string) {
    const socket = this.sockets.findLast((s) => !s.ended);
    if (!socket) throw new Error("socket unavailable");
    try {
      await socket.sendMessage(jid, { text: "boundary probe" });
      return false;
    } catch {
      return true;
    }
  }
}

export class DeterministicDeepSeekSystemDouble {
  readonly calls: string[] = [];
  active = false;
  next: "success" | "timeout" | "error" = "success";
  summaryNext: "success" | "timeout" | "error" = "success";
  nativeCalls: ReceptionistToolCommand[] | ((messages: Array<{ role: string; content: string | null }>) => ReceptionistToolCommand[]) = [];
  nativeFinal: ((results: ReceptionistToolResult[]) => string) | null = null;
  private agendaTransport: "success" | "header-deadline" | "body-deadline" | "error" = "success";
  private observedFailure?: () => void;
  agendaAborts = 0;
  configureAgendaTransport(mode: typeof this.agendaTransport): Promise<void> {
    this.agendaTransport = mode;
    if (mode === "success") return Promise.resolve();
    return new Promise(resolve => { this.observedFailure = resolve; });
  }
  readonly fetcher = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!this.active) throw new Error("DeepSeek double is not ready");
    const body = String(init?.body ?? ""),
      summary = body.includes("Resumen estructurado");
    this.calls.push(body);
    const outcome = summary ? this.summaryNext : this.next;
    if (summary) this.summaryNext = "success";
    else this.next = "success";
    if (outcome === "timeout") throw new Error("deterministic timeout");
    if (outcome === "error")
      return new Response("provider unavailable", { status: 503 });
    const payload = JSON.parse(body);
    const agenda = !summary && Array.isArray(payload.tools);
    if (agenda && this.agendaTransport === "error") {
      this.observedFailure?.();
      return new Response("provider unavailable", { status: 503 });
    }
    if (agenda && this.agendaTransport !== "success") {
      const signal = init?.signal;
      if (!signal) throw new Error("Deadline transport requires an abort signal");
      if (this.agendaTransport === "header-deadline") return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          this.agendaAborts++;
          this.observedFailure?.();
          reject(new Error("aborted header transport"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      let abort: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start: controller => {
          abort = () => {
            signal.removeEventListener("abort", abort);
            this.agendaAborts++;
            this.observedFailure?.();
            controller.error(new Error("aborted body transport"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        },
        cancel: () => { signal.removeEventListener("abort", abort); },
      });
      return new Response(stream, { status: 200 });
    }
    const content = summary
      ? JSON.stringify({
          facts: ["Resumen determinista"],
          requests: [],
          commitments: [],
          preferences: [],
          openItems: [],
        })
      : "No se guardó ningún cambio de agenda.";
    let message: Record<string, unknown> = { role: "assistant", content };
    let finish_reason = "stop";
    if (agenda) {
      const messages = payload.messages as Array<{ role: string; content: string | null; tool_call_id?: string }>;
      if (messages.at(-1)?.role === "tool") {
        const firstResult = messages.findLastIndex(item => item.role !== "tool") + 1;
        const results = messages.slice(firstResult).map(item => JSON.parse(item.content!) as ReceptionistToolResult);
        const catalog = results[0]?.status === "data" ? results[0].data as { items?: Array<{ name: string; durationMinutes: number; priceArs: number }> } : null;
        message.content = this.nativeFinal ? this.nativeFinal(results)
          : catalog?.items ? catalog.items.map(item => `${item.name}: ${item.durationMinutes} minutos, ARS ${item.priceArs}`).join("\n") || "No hay servicios activos."
          : content;
      } else {
        const calls = typeof this.nativeCalls === "function" ? this.nativeCalls(messages) : this.nativeCalls;
        if (calls.length) {
          message = { role: "assistant", content: null, tool_calls: calls.map((command, index) => ({
            id: `system-${this.calls.length}-${index}`, type: "function",
            function: { name: command.name, arguments: JSON.stringify(command.arguments) },
          })) };
          finish_reason = "tool_calls";
        }
      }
    }
    return new Response(
      JSON.stringify({
        id: `deepseek-${this.calls.length}`,
        choices: [{ message, finish_reason }],
        usage: { total_tokens: 3 },
      }),
      { status: 200 },
    );
  };
}

export class SystemProviders {
  readonly baileys = new DeterministicBaileysSystemDouble();
  readonly deepSeek = new DeterministicDeepSeekSystemDouble();
  start() {
    this.baileys.active = true;
    this.deepSeek.active = true;
  }
  probe() {
    return { baileys: this.baileys.active, deepSeek: this.deepSeek.active };
  }
  stop() {
    this.baileys.active = false;
    this.deepSeek.active = false;
  }
}
