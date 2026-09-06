export async function GET() {
  const origin = process.env.AGENDIA_API_ORIGIN;
  if (!origin) return Response.json({ code: "api.unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  try {
    const response = await fetch(new URL("/internal/ready", origin), { cache: "no-store" });
    const body = await response.json().catch(() => ({ code: "api.unavailable" }));
    const code = typeof body?.code === "string" ? body.code : "api.unavailable";
    return Response.json({ code }, { status: response.status === 200 ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ code: "api.unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
