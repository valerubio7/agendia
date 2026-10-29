import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { startWebProxy } from "../e2e/support/web-proxy.ts";

test("proxy streams request bodies and preserves origin and cookies to the selected target", async () => {
  const server = createServer((req, res) => {
    res.setHeader("set-cookie", ["one=1; Path=/", "two=2; Path=/"]);
    res.write(`${req.url}|${req.headers.origin}|${req.headers.cookie}|`);
    req.pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const proxy = await startWebProxy(origin, origin);
  try {
    const response = await fetch(`${proxy.url}/api/probe?q=1`, {
      method: "POST", headers: { origin: proxy.url, cookie: "session=one" }, body: "body",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("one=1");
    expect(response.headers.get("set-cookie")).toContain("two=2");
    expect(await response.text()).toBe(`/probe?q=1|${proxy.url}|session=one|body`);
  } finally {
    await proxy.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await expect(fetch(`${proxy.url}/api/probe`)).rejects.toThrow();
});

test("proxy forwards streaming chunks before request completion and propagates truncated responses", async () => {
  let received!: () => void;
  const firstChunk = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer((req, res) => {
    req.once("data", () => received());
    req.on("end", () => { res.writeHead(200); res.write("partial"); setTimeout(() => res.destroy(), 20); });
    req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const proxy = await startWebProxy(origin, origin);
  try {
    const result = new Promise<string>((resolve, reject) => {
      const client = request(`${proxy.url}/api/stream`, { method: "POST" }, (response) => {
        response.resume();
        response.once("aborted", () => resolve("aborted"));
        response.once("end", () => resolve("complete"));
        response.once("error", () => resolve("aborted"));
      });
      client.once("error", reject);
      client.write("first");
      void firstChunk.then(() => client.end("second"));
    });
    expect(await Promise.race([result, new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2000))])).toBe("aborted");
  } finally {
    await proxy.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("client abort and proxy stop close their pending upstream requests", async () => {
  let arrived!: () => void, closed!: () => void;
  let arrival = new Promise<void>((resolve) => { arrived = resolve; });
  let closure = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((_req, res) => { arrived(); res.once("close", () => closed()); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const proxy = await startWebProxy(origin, origin);
  const bounded = (promise: Promise<unknown>) => Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
  try {
    const client = request(`${proxy.url}/api/pending`);
    client.on("error", () => {}); client.end();
    expect(await bounded(arrival)).toBe(true);
    client.destroy();
    expect(await bounded(closure)).toBe(true);
    arrival = new Promise<void>((resolve) => { arrived = resolve; });
    closure = new Promise<void>((resolve) => { closed = resolve; });
    const pending = request(`${proxy.url}/api/pending`);
    pending.on("error", () => {}); pending.end();
    expect(await bounded(arrival)).toBe(true);
    expect(await bounded(proxy.stop())).toBe(true);
    expect(await bounded(closure)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
