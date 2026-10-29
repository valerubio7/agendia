import { Agent, createServer, request, type ClientRequest, type Server } from "node:http";
import type { Socket } from "node:net";

export async function startWebProxy(nextOrigin: string, apiOrigin: string) {
  const sockets = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  const agent = new Agent({ keepAlive: true });
  const server: Server = createServer((incoming, outgoing) => {
    const api = incoming.url === "/api" || incoming.url?.startsWith("/api/") || incoming.url?.startsWith("/api?");
    const path = api ? incoming.url!.slice(4) || "/" : incoming.url!;
    const target = new URL(api ? apiOrigin : nextOrigin);
    const upstream = request({ hostname: target.hostname, port: target.port, method: incoming.method,
      path: path.startsWith("?") ? `/${path}` : path, headers: incoming.headers, agent }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    requests.add(upstream);
    upstream.on("close", () => requests.delete(upstream));
    upstream.on("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else { outgoing.writeHead(502); outgoing.end(); }
    });
    incoming.on("error", () => upstream.destroy());
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => { if (!outgoing.writableFinished) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy port unavailable");
  return {
    url: `http://localhost:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      for (const upstream of requests) upstream.destroy();
      agent.destroy();
      for (const socket of sockets) socket.destroy();
    }),
  };
}
