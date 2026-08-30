export const queueErrorComponents = [
  "message-worker",
  "whatsapp-manager",
] as const;

export type QueueErrorComponent = (typeof queueErrorComponents)[number];

type ErrorEventEmitter = {
  on(event: "error", listener: (error: unknown) => void): void;
};

type SafeLineWriter = (line: string) => void;

const queueErrorComponentAllowlist = new Set<string>(queueErrorComponents);
const queueErrorCode = "queue.error" as const;

export function containQueueErrors(
  emitter: ErrorEventEmitter,
  component: QueueErrorComponent,
  write: SafeLineWriter = (line) => console.error(line),
): void {
  if (!queueErrorComponentAllowlist.has(component))
    throw new TypeError("Unsupported queue error component");

  emitter.on("error", (_error) => {
    write(JSON.stringify({ code: queueErrorCode, component }));
  });
}
