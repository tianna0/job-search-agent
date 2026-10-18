/**
 * True when a once-a-day job should run: it's at or after `hour` (local time)
 * and the last run started before today's `hour`.
 */
export function dailyDue(lastRunIso: string | null | undefined, now: Date, hour: number): boolean {
  const todayMark = new Date(now);
  todayMark.setHours(hour, 0, 0, 0);
  if (now < todayMark) return false;
  if (!lastRunIso) return true;
  const last = Date.parse(lastRunIso);
  return Number.isNaN(last) || last < todayMark.getTime();
}
