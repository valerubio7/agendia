import type { AgentDatePresentation } from "./tools.ts";

/** Indices refer to returned items; ranges describe starts, not appointment ends. */
export function presentAvailability<T extends { startsAt: string; resourceId: string; presentation: AgentDatePresentation | null }>(
  bounded: { items: T[]; hasMore: boolean },
) {
  const seen = new Set<number>();
  const starts = bounded.items.flatMap((item, index) => {
    const instant = Date.parse(item.startsAt);
    if (seen.has(instant)) return [];
    seen.add(instant);
    return [{ item, index, instant }];
  }).sort((a, b) => a.instant - b.instant);
  const localMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const startGroups: { first: number; last: number }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const first = starts[i]!;
    let last = first;
    while (i + 1 < starts.length) {
      const next = starts[i + 1]!;
      if (!last.item.presentation || !next.item.presentation || next.instant - last.instant !== 15 * 60_000
        || next.item.resourceId !== first.item.resourceId
        || next.item.presentation.timeZone !== last.item.presentation.timeZone
        || next.item.presentation.localDate !== first.item.presentation?.localDate
        || localMinutes(next.item.presentation.localTime) - localMinutes(last.item.presentation.localTime) !== 15) break;
      last = next;
      i++;
    }
    startGroups.push({ first: first.index, last: last.index });
  }
  return { ...bounded, startGroups };
}
