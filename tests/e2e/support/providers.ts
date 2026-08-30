import type { SocketFactory } from "@agendia/whatsapp-baileys";

type SendOutcome = "ack" | "rejected" | "crash";
class DeterministicSocket {
  readonly ready: Promise<void>;
  readonly user: { id: string };
  ended = false;
  private resolveReady!: () => void;
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
      this.listeners.set(name, listener);
      if (name !== "connection.update") return;
      queueMicrotask(async () => {
        await listener({ qr: `deterministic-qr-${this.index}` });
        setTimeout(async () => {
          await listener({ connection: "open" });
          this.resolveReady();
        }, 750);
      });
    },
  };
  async emit(name: string, value: Record<string, unknown>) {
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
    void this.listeners.get("connection.update")?.({ connection: "close" });
  }
  end() {
    this.ended = true;
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
    await socket.emit("messages.upsert", { messages: [message] });
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
    const content = summary
      ? JSON.stringify({
          facts: ["Resumen determinista"],
          requests: [],
          commitments: [],
          preferences: [],
          openItems: [],
        })
      : `Respuesta determinista ${this.calls.length}`;
    return new Response(
      JSON.stringify({
        id: `deepseek-${this.calls.length}`,
        choices: [{ message: { content } }],
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
