export function GET() {
	return Response.json(
		{ code: "live" },
		{ status: 200, headers: { "cache-control": "no-store" } },
	);
}
