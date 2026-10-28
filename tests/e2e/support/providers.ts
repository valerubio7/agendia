import type { SocketFactory } from "@agendia/whatsapp-baileys";
import type { AgentToolCommand, AgentToolResult } from "../../../apps/message-worker/src/agent/tools.ts";

// Scripted model wording for deterministic guards; never imported by production.
export function scriptedAgentReply(results: AgentToolResult[], toolName?: string): string {
  const result = results.find(item => item.status === "staged_action") ?? results.at(-1);
  const r = result as any;
  let text = "¿Qué servicio y día querés consultar?";
  if (r?.status === "prepared_quote") {
    const q = r.quote, t = q.terms, p = r.presentation;
    text = (r.reason === "TERMS_CHANGED" ? "Las condiciones cambiaron. " : r.reason === "PROPOSAL_NOT_DELIVERED" ? "Primero necesitás recibir el detalle de la propuesta. " : "")
      + `${q.kind === "book" ? "Reserva propuesta" : "Cambio propuesto"}: ${t.serviceName}, ${p.localDate} a las ${p.localTime}, ${t.durationMinutes} minutos, ARS ${t.priceArs}. Respondé «confirmo» para guardar. Todavía no está guardado.`;
  } else if (r?.status === "staged_action") {
    const ap = r.appointment, t = ap.terms, p = ap.presentation;
    text = r.operation === "cancel" ? `Cancelación guardada. Turno ${ap.id}.`
      : r.operation === "notes" ? "Nota guardada."
      : r.operation === "preference" ? "Preferencia guardada. No cambia la asignación ni garantiza disponibilidad."
      : `Guardado: ${t.serviceName}, ${p.localDate} a las ${p.localTime}, ${t.durationMinutes} minutos, ARS ${t.priceArs}. Turno ${ap.id}.`;
  } else if (r?.alternatives || r?.data?.date) {
    const slots = r.alternatives ?? r.data;
    const scope = slots.resourceName ? ` con ${slots.resourceName}` : "";
    const days = new Map<string, Set<string>>();
    for (const slot of slots.items) {
      const p = slot.presentation;
      if (!days.has(p.localDate)) days.set(p.localDate, new Set());
      days.get(p.localDate)!.add(p.localTime);
    }
    text = days.size ? `Horarios disponibles${scope}: ${[...days].map(([day, times]) => `${day}: ${[...times].join(", ")}`).join("; ")}. ¿Cuál elegís?`
      : `No hay horarios disponibles${scope}${slots.date ? ` para ${slots.date}` : " en ese día ni en los días cercanos consultados"}. ¿Qué otro día te sirve?`;
    if (r.alternatives) text = "El horario ya no está disponible. " + text;
  } else if (r?.reason === "MISSING_NAMES") {
    text = r.missingFields.length === 2 ? "Decime tu nombre y apellido."
      : r.missingFields.includes("lastName") ? "Decime tu apellido." : "Decime tu nombre.";
  } else if (r?.reason === "UNKNOWN_RESOURCE" || r?.code === "UNKNOWN_RESOURCE") text = "No reconocí el recurso solicitado. ¿Cuál querés?";
  else if (r?.reason === "APPOINTMENT_CHANGED") text = "El turno cambió desde la propuesta. Pedí el cambio nuevamente; no se guardó nada.";
  else if (r?.reason === "CANCELLATION_REQUIRED") text = "Indicá explícitamente si querés cancelar tu turno.";
  else if (r?.reason === "NOTE_REQUEST_REQUIRED") text = "Escribí «nota: texto» o «borrar nota» para modificar la nota de tu turno.";
  else if (r?.code === "UNVERIFIED_SENDER") text = "No pude verificar tu número. No se guardó ningún cambio.";
  else if (r?.status === "rejected" || r?.status === "clarification") text = "No se guardó ningún cambio. No pude verificar la operación. ¿Podés aclarar qué necesitás?";
  else if (r?.data) {
    const d = r.data;
    if (d.pending === "retained") text = "La propuesta pendiente no cambió. Todavía no se guardó ningún cambio.";
    else if (d.pending === "unchanged") text = "El turno ya tiene esos datos. No se guardó ningún cambio.";
    else if ("address" in d) text = d.address ? `Dirección registrada: ${JSON.stringify(d.address)}.` : "No hay dirección registrada.";
    else if (d.weeklySchedule) text = Object.keys(d.weeklySchedule).length ? "Horarios habituales registrados; no establecen disponibilidad." : "No hay horarios habituales registrados.";
    else if (d.items) text = d.items.length ? d.items.map((item: any) => item.priceArs !== undefined
      ? `${item.name}: ${item.durationMinutes} minutos, ARS ${item.priceArs}` : item.terms ? `Turno registrado: ${item.terms.serviceName}, ${item.presentation.label}.` : item.name).join("\n") : toolName === "read_catalog" ? "No hay servicios activos registrados." : "No tenés turnos registrados.";
  }
  return JSON.stringify({ text, ...(r?.status === "prepared_quote" ? { presentedQuoteReference: r.presentationReference } : {}) });
}

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
  nativeCalls: AgentToolCommand[] | ((messages: Array<{ role: string; content: string | null }>) => AgentToolCommand[]) = [];
  nativeFinal: ((results: AgentToolResult[]) => string) | null = null;
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
    let message: Record<string, unknown> = { role: "assistant", content: agenda ? JSON.stringify({ text: content }) : content };
    let finish_reason = "stop";
    if (agenda) {
      const messages = payload.messages as Array<{ role: string; content: string | null; tool_call_id?: string }>;
      if (messages.at(-1)?.role === "tool") {
        const firstResult = messages.findLastIndex(item => item.role !== "tool") + 1;
        const results = messages.slice(firstResult).map(item => JSON.parse(item.content!) as AgentToolResult);
        message.content = this.nativeFinal ? this.nativeFinal(results) : scriptedAgentReply(results, payload.messages[firstResult - 1]?.tool_calls?.[0]?.function?.name);
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
