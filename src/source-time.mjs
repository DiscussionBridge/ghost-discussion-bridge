// Date.parse normalizes some impossible calendar dates. Source timestamps are
// authoritative evidence, so validate their actual components before parsing.
export function sourceTime(value) {
  if (typeof value !== "string") return null;
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!fields) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = fields;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
    || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return null;
  const milliseconds = Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone}`);
  if (!Number.isFinite(milliseconds)) return null;
  // Preserve the declared fractional precision for chronology checks rather
  // than silently losing source nanoseconds through JavaScript milliseconds.
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}
