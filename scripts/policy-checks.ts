const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "DeepSeek credential pattern", pattern: /sk-[A-Za-z0-9_-]{24,}/ },
  { label: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "Baileys credential payload", pattern: /(?:noiseKey|signedIdentityKey|advSecretKey)\s*[=:]\s*["'][A-Za-z0-9+/=]{16,}/ },
];
const OUT_OF_SCOPE = /(?:^|\/)(?:conversations?|messages?|inbox|search)(?:\/|$)/i;

export function scanForSecrets(files: Record<string, string>): string[] {
  const findings: string[] = [];
  for (const [path, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    for (const candidate of SECRET_PATTERNS) {
      if (candidate.pattern.test(content)) findings.push(`${path}: ${candidate.label}`);
    }
  }
  return findings;
}

export function checkV1Scope(routes: readonly string[], paths: readonly string[]): string[] {
  return [
    ...routes.filter((route) => OUT_OF_SCOPE.test(route)).map((route) => `route outside v1: ${route}`),
    ...paths.filter((path) => OUT_OF_SCOPE.test(path)).map((path) => `path outside v1: ${path}`),
  ];
}
