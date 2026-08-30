export const tddEvidenceColumns = [
  "SAFETY NET", "RED", "GREEN", "TRIANGULATE", "REFACTOR",
  "file", "literal command", "exit code", "result",
] as const;

export type TddPhase = typeof tddEvidenceColumns[number] & ("SAFETY NET" | "RED" | "GREEN" | "TRIANGULATE" | "REFACTOR");

export interface TddCycleRecord {
  phase: TddPhase;
  detail: string;
  file: string;
  command: string;
  exitCode: number;
  result: string;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatTddCycleRecord(record: TddCycleRecord): string {
  const phases = tddEvidenceColumns.slice(0, 5).map((phase) => phase === record.phase ? cell(record.detail) : "—");
  return `| ${phases.join(" | ")} | \`${cell(record.file)}\` | \`${cell(record.command)}\` | ${record.exitCode} | ${cell(record.result)} |`;
}
