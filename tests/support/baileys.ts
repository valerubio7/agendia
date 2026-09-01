type Listener = (value: Record<string, unknown>) => void | Promise<void>;

export class FakeBaileysSocket {
  user?: { id: string };
  readonly ready: Promise<void>;
  readonly sentRecipients: string[] = [];
  ended = 0;
  expectedRecipient?: string;
  private readonly listeners = new Map<string, Listener>();
  private resolveReady!: () => void;
  constructor(private readonly updates: object[] = []) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
  readonly ev = {
    on: (name: string, listener: Listener) => {
      this.listeners.set(name, listener);
      if (name === "connection.update")
        queueMicrotask(async () => {
          for (const update of this.updates)
            await listener(update as Record<string, unknown>);
          this.resolveReady();
        });
    },
  };
  async emit(name: string, value: Record<string, unknown>): Promise<void> {
    await this.listeners.get(name)?.(value);
  }
  async sendMessage(jid: string) {
    this.sentRecipients.push(jid);
    if (!jid || (this.expectedRecipient && jid !== this.expectedRecipient))
      throw Object.assign(new Error("invalid recipient"), {
        code: "WA_REJECTED",
      });
    return { key: { id: "ack-1" } };
  }
  end(): void {
    this.ended += 1;
  }
}
