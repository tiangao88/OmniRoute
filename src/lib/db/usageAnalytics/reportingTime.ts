/** Read-only IANA calendar grouping, using portable SQLite expressions. */
import { z } from "zod";

export const reportingTimeZoneSchema = z.enum(["UTC", "Europe/Paris"]);
export interface ReportingTimeOptions {
  timeZone: string;
  sinceIso: string | null;
  untilIso: string | null;
}
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const cache = new Map<string, string>();
function civilParts(stamp: number): Record<string, number> {
  return Object.fromEntries(
    formatter
      .formatToParts(new Date(stamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}
export function reportingDate(stamp: Date, timeZone = "UTC"): string {
  reportingTimeZoneSchema.parse(timeZone);
  if (timeZone === "UTC") return stamp.toISOString().slice(0, 10);
  const p = civilParts(stamp.getTime());
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function validParisWindow(sinceIso: string | null, untilIso: string | null): boolean {
  if (!sinceIso || !untilIso) return false;
  const start = Date.parse(sinceIso),
    end = Date.parse(untilIso);
  return (
    Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 366 * 86400000
  );
}
function offsetMinutes(stamp: number): number {
  const p = civilParts(stamp);
  return (
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
      Math.floor(stamp / 1000) * 1000) /
    60000
  );
}
/** Only generated numeric offsets and normalized ISO instants enter SQL.
 * No user SQL, process TZ mutation, schema change or driver-specific UDF.
 * The finite window is sampled daily; IANA supplies the actual DST rules.
 */
export function reportingDaySql(options?: ReportingTimeOptions): string {
  const zone = reportingTimeZoneSchema.parse(options?.timeZone ?? "UTC");
  if (zone === "UTC") return "DATE(timestamp)";
  if (!options || !validParisWindow(options.sinceIso, options.untilIso))
    throw new Error("Invalid reporting time window");
  const key = `${zone}|${options.sinceIso}|${options.untilIso}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const start = Math.floor(Date.parse(options.sinceIso!) / 1000) * 1000;
  const end = Math.ceil(Date.parse(options.untilIso!) / 1000) * 1000;
  let previous = start,
    offset = offsetMinutes(start);
  const transitions: Array<{ instant: number; before: number }> = [];
  for (
    let sample = Math.min(start + 86400000, end);
    sample > previous;
    sample = Math.min(sample + 86400000, end)
  ) {
    const nextOffset = offsetMinutes(sample);
    if (nextOffset !== offset) {
      let low = previous,
        high = sample;
      while (high - low > 1000) {
        const middle = Math.floor((low + high) / 2000) * 1000;
        if (offsetMinutes(middle) === offset) low = middle;
        else high = middle;
      }
      transitions.push({ instant: high, before: offset });
      offset = nextOffset;
    }
    previous = sample;
  }
  const modifier = transitions.length
    ? "CASE " +
      transitions
        .map(
          (t) =>
            `WHEN julianday(timestamp) < julianday('${new Date(t.instant).toISOString()}') THEN '${t.before} minutes'`
        )
        .join(" ") +
      ` ELSE '${offset} minutes' END`
    : `'${offset} minutes'`;
  const result = `DATE(timestamp, ${modifier})`;
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
