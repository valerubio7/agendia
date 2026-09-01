export const immediateOutboxRecovery = {
  claimTtlMs: 0,
  retryBaseMs: 0,
} as const;

export function deepSeekFetchDouble(
  result: { text: string } | { error: Error },
) {
  const calls: string[] = [];
  const fetcher = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push(String(init?.body ?? ""));
    if ("error" in result) throw result.error;
    return new Response(
      JSON.stringify({
        id: "deterministic",
        choices: [{ message: { content: result.text } }],
      }),
      { status: 200 },
    );
  };
  return { calls, fetcher };
}
