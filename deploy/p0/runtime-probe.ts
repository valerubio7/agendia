import { writeFileSync } from "node:fs";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { PgBoss } from "pg-boss";
import {
  BaileysAuthStateAdapter,
  BaileysAuthStore,
  BaileysGateway,
  InMemoryAuthRecordRepository,
  InMemoryKms,
  type BaileysSocket,
} from "@agendia/whatsapp-baileys";

type ProbeMode = "native" | "baileys" | "queue" | "filesystem";

export async function runRuntimeProbe(mode: ProbeMode): Promise<Record<string, unknown>> {
  if (mode === "native") {
    const encoded = await hash("p0-password", { algorithm: Algorithm.Argon2id });
    return { nativeArgon2: await verify(encoded, "p0-password") };
  }
  if (mode === "baileys") {
    let options: Record<string, unknown> = {}, listener: (value: Record<string, unknown>) => unknown = () => undefined;
    let ready!: () => void;
    const socket: BaileysSocket = {
      user: { id: "15550000000:1@s.whatsapp.net" },
      ready: new Promise<void>((resolve) => { ready = resolve; }),
      ev: { on(name, callback) { if (name === "connection.update") listener = callback; } },
      end() {},
    };
    const auth = new BaileysAuthStateAdapter(new BaileysAuthStore(
      new InMemoryAuthRecordRepository(),
      new InMemoryKms({ p0: Buffer.alloc(32, 7) }, "p0"),
    ));
    const gateway = new BaileysGateway(
      (id) => auth.load("11111111-1111-4111-8111-111111111111", id),
      (value) => { options = value; queueMicrotask(async () => {
        await listener({ qr: "p0-deterministic-qr" });
        await listener({ connection: "open" });
        ready();
      }); return socket; },
    );
    const events: Array<Record<string, unknown>> = [];
    const lease = await gateway.connect("p0-connection", (event) => events.push(event));
    lease.close();
    return {
      baileys: events.some((event) => event.type === "open"),
      qr: events.find((event) => event.type === "qr")?.value,
      browser: options.browser,
    };
  }
  if (mode === "queue") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for queue probe");
    const boss = new PgBoss({ connectionString, schema: "p0boss" });
    await boss.start();
    await boss.createQueue("p0-release-probe");
    let consumed = "";
    await boss.work<{ value: string }>("p0-release-probe", async ([job]) => {
      consumed = job?.data.value ?? "";
    });
    const published = await boss.send("p0-release-probe", { value: "published-and-consumed" });
    for (let attempt = 0; attempt < 100 && !consumed; attempt++)
      await Bun.sleep(50);
    await boss.stop();
    if (!published || consumed !== "published-and-consumed")
      throw new Error("pg-boss publish/consume probe failed");
    return { pgBoss: consumed };
  }
  const writable = process.env.P0_WRITABLE_PATH;
  if (!writable) throw new Error("P0_WRITABLE_PATH is required for filesystem probe");
  writeFileSync(`${writable}/p0-write`, "ok");
  let denied = false;
  try { writeFileSync("/opt/agendia/p0-forbidden", "must fail"); } catch { denied = true; }
  if (!denied) throw new Error("read-only root accepted a forbidden write");
  return { writable, denied: "/opt/agendia" };
}

if (import.meta.main) {
  const mode = process.argv[2] as ProbeMode;
  console.log(JSON.stringify(await runRuntimeProbe(mode)));
}
