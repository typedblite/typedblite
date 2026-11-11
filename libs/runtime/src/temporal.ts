import type { Range } from 'vscode-languageserver';
import { DiagnosticCode } from './diagnostics.js';
import type { Refuse } from './schema-rules.js';

/**
 * Dates, datetimes, zoned datetimes and durations — their arithmetic, as TypeDB does it
 * (expression.feature L492–L850).
 *
 * - A **date** or **datetime** is a day number and the nanoseconds into it, years −262143 to +262142
 *   (`+262143-01-01` is "Invalid date", L692). A date is its midnight.
 * - A **duration** is months, days and exact nanoseconds — never negative, at most 6,291,432 months
 *   (the span of the year range; `P524287Y` is out of range, L825). `P66W` is `P462D`.
 * - `datetime − datetime` is a CALENDAR difference — whole months, then days, then the time —
 *   `2027-03-30 − 2026-01-27` is `P1Y2M3D`, not a count of days (L492).
 * - `datetime ± duration` moves the calendar (months, clamped to the month's length, then days) and
 *   then the clock. In a named zone the calendar moves in LOCAL time, so `+ P1D` keeps the wall time
 *   across DST and `+ PT24H` does not (L746, L760); a local time that falls in a gap is advanced by
 *   the gap's length, and an ambiguous one is the earlier instant (L773, L786). A zoned literal that
 *   falls in a gap or an overlap is refused (L728).
 *
 * 🔴 No `Date` arithmetic: a `Date` is milliseconds and a range of ±275,000 years, and this needs
 * nanoseconds — days are integers, the clock is a `BigInt`. `Intl` is asked only for a zone's
 * offset at an instant, which is all a zone is.
 */

const NANOS_PER_DAY = BigInt(86_400) * BigInt(1_000_000_000);
const NANOS_PER_MS = BigInt(1_000_000);
const MIN_YEAR = -262143;
const MAX_YEAR = 262142;
/** `P524286Y` — the span of the year range, in months. */
const MAX_MONTHS = (MAX_YEAR - MIN_YEAR + 1) * 12;

export interface Duration {
  readonly months: number;
  readonly days: number;
  readonly nanos: bigint;
}

/** A naive local date-time: a day number (0 is 1970-01-01) and the nanoseconds into that day. */
interface Naive {
  readonly days: number;
  readonly nanos: bigint;
}

type Zone = { readonly kind: 'offset'; readonly minutes: number; readonly text: string } | { readonly kind: 'named'; readonly name: string };

// ── the civil calendar (proleptic Gregorian; Howard Hinnant's algorithms) ─────────────────────

const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const civilFromDays = (days: number): { year: number; month: number; day: number } => {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
};

const daysInMonth = (year: number, month: number): number => daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - daysFromCivil(year, month, 1);

// ── text ─────────────────────────────────────────────────────────────────────

const DATETIME = /^([+-]?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/;

const invalid = (refuse: Refuse, at: Range | undefined, text: string): never => refuse(DiagnosticCode.valueOutOfRange, `Invalid date: '${text}' is outside the range TypeDB holds (years ${MIN_YEAR} to +${MAX_YEAR}).`, at);

/** A date or datetime's naive value, and what follows it in the text (a zone). */
function parseNaive(text: string, refuse: Refuse, at: Range | undefined): { naive: Naive; rest: string } {
  const match = DATETIME.exec(text);
  if (match === null) return refuse(DiagnosticCode.valueTypeConflict, `'${text}' is not a date or datetime.`, at);
  const [whole, y, mo, d, h = '0', mi = '0', s = '0', fraction = ''] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < MIN_YEAR || year > MAX_YEAR) invalid(refuse, at, text);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    refuse(DiagnosticCode.valueTypeConflict, `Invalid date: '${text}' names no day or time that exists.`, at);
  }
  const nanos = BigInt(((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1_000) * NANOS_PER_MS + BigInt(fraction.padEnd(9, '0').slice(0, 9));
  return { naive: { days: daysFromCivil(year, month, day), nanos }, rest: text.slice(whole.length) };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

const formatYear = (year: number): string => (year >= 0 && year <= 9999 ? pad(year, 4) : `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 6)}`);

const formatDate = (days: number): string => {
  const { year, month, day } = civilFromDays(days);
  return `${formatYear(year)}-${pad(month)}-${pad(day)}`;
};

const formatNaive = (naive: Naive): string => {
  const seconds = Number(naive.nanos / BigInt(1_000_000_000));
  const fraction = String(naive.nanos % BigInt(1_000_000_000)).padStart(9, '0').replace(/0+$/, '');
  return `${formatDate(naive.days)}T${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}${fraction === '' ? '' : `.${fraction}`}`;
};

const checkRange = (naive: Naive, refuse: Refuse, at: Range | undefined): Naive => {
  const { year } = civilFromDays(naive.days);
  if (year < MIN_YEAR || year > MAX_YEAR) refuse(DiagnosticCode.valueOutOfRange, `The result ${formatNaive(naive)} is outside the range TypeDB holds (years ${MIN_YEAR} to +${MAX_YEAR}).`, at);
  return naive;
};

const normalise = (naive: Naive): Naive => {
  const carry = naive.nanos >= BigInt(0) ? naive.nanos / NANOS_PER_DAY : (naive.nanos - NANOS_PER_DAY + BigInt(1)) / NANOS_PER_DAY;
  return { days: naive.days + Number(carry), nanos: naive.nanos - carry * NANOS_PER_DAY };
};

// ── durations ────────────────────────────────────────────────────────────────

const DURATION = /^P(?:(\d+)W|(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?)$/;

export function parseDuration(text: string, refuse: Refuse, at: Range | undefined): Duration {
  const match = DURATION.exec(text.trim());
  if (match === null) return refuse(DiagnosticCode.valueTypeConflict, `'${text}' is not a duration.`, at);
  const [, weeks, years = '0', months = '0', days = '0', hours = '0', minutes = '0', seconds = '0', fraction = ''] = match;
  const duration = {
    months: Number(years) * 12 + Number(months),
    days: weeks === undefined ? Number(days) : Number(weeks) * 7,
    nanos: (BigInt(hours) * BigInt(3600) + BigInt(minutes) * BigInt(60) + BigInt(seconds)) * BigInt(1_000_000_000) + BigInt(fraction.padEnd(9, '0').slice(0, 9)),
  };
  return checkDuration(duration, refuse, at);
}

const checkDuration = (duration: Duration, refuse: Refuse, at: Range | undefined): Duration => {
  if (duration.months < 0 || duration.days < 0 || duration.nanos < BigInt(0)) {
    refuse(DiagnosticCode.valueOutOfRange, 'A duration cannot be negative: the result is out of range.', at);
  }
  if (duration.months > MAX_MONTHS) refuse(DiagnosticCode.valueOutOfRange, `A duration of ${duration.months} months is out of range: at most ${MAX_MONTHS}.`, at);
  return duration;
};

/**
 * A duration as TypeDB writes one — `P1Y2M3DT4H5M6.789S`; the clock in hours, minutes and seconds,
 * the fraction trimmed (or, with `nanoseconds`, all nine digits — what `fetch` answers, L746);
 * `PT0S` for nothing.
 */
export function formatDuration(duration: Duration, nanoseconds = false): string {
  const years = Math.floor(duration.months / 12);
  const months = duration.months % 12;
  const seconds = duration.nanos / BigInt(1_000_000_000);
  const fraction = String(duration.nanos % BigInt(1_000_000_000)).padStart(9, '0');
  const shown = nanoseconds ? fraction : fraction.replace(/0+$/, '');
  const h = seconds / BigInt(3600);
  const m = (seconds / BigInt(60)) % BigInt(60);
  const s = seconds % BigInt(60);
  const date = `${years ? `${years}Y` : ''}${months ? `${months}M` : ''}${duration.days ? `${duration.days}D` : ''}`;
  const hasFraction = /[1-9]/.test(fraction);
  const time = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || hasFraction ? `${s}${hasFraction ? `.${shown}` : ''}S` : ''}`;
  if (date === '' && time === '') return 'PT0S';
  return `P${date}${time === '' ? '' : `T${time}`}`;
}

// ── zones ────────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (zone: string, refuse: Refuse, at: Range | undefined): Intl.DateTimeFormat => {
  const known = formatters.get(zone);
  if (known !== undefined) return known;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' });
    formatters.set(zone, formatter);
    return formatter;
  } catch {
    return refuse(DiagnosticCode.valueTypeConflict, `Unknown time zone '${zone}'.`, at);
  }
};

/** A named zone's offset from UTC, in milliseconds, at an instant (milliseconds since the epoch). */
const offsetAt = (zone: string, instant: number, refuse: Refuse, at: Range | undefined): number => {
  const parts = Object.fromEntries(formatterFor(zone, refuse, at).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  const local = daysFromCivil(year, Number(parts.month), Number(parts.day)) * 86_400_000 + ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  return local - (instant - (((instant % 1000) + 1000) % 1000));
};

const parseZone = (text: string, refuse: Refuse, at: Range | undefined): Zone | undefined => {
  const zone = text.trim();
  if (zone === '') return undefined;
  if (zone === 'Z') return { kind: 'offset', minutes: 0, text: 'Z' };
  const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (offset !== null) {
    const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1);
    return { kind: 'offset', minutes, text: `${offset[1]}${offset[2]}:${offset[3]}` };
  }
  formatterFor(zone, refuse, at);
  return { kind: 'named', name: zone };
};

const zoneText = (zone: Zone): string => (zone.kind === 'offset' ? zone.text : zone.name);

const localMs = (naive: Naive): number => naive.days * 86_400_000 + Number(naive.nanos / NANOS_PER_MS);
const subMs = (naive: Naive): bigint => naive.nanos % NANOS_PER_MS;
const describe = (naive: Naive): string => formatNaive(naive).replace('T', ' ');

/**
 * The instant a LOCAL time names in a zone, as UTC naive. `strict` refuses a time in a gap or an
 * overlap (a literal, L728); otherwise a gap is advanced by its length and an overlap is the
 * earlier instant (a result of arithmetic, L773, L786).
 */
function toInstant(local: Naive, zone: Zone, strict: boolean, refuse: Refuse, at: Range | undefined): Naive {
  if (zone.kind === 'offset') {
    const instant = normalise({ days: local.days, nanos: local.nanos - BigInt(zone.minutes) * BigInt(60_000) * NANOS_PER_MS });
    const { year } = civilFromDays(instant.days);
    if (year < MIN_YEAR || year > MAX_YEAR) refuse(DiagnosticCode.valueOutOfRange, `Local time ${describe(local)} does not exist in timezone ${zone.text}.`, at);
    return instant;
  }
  const ms = localMs(local);
  const offsets = [...new Set([offsetAt(zone.name, ms - 86_400_000, refuse, at), offsetAt(zone.name, ms + 86_400_000, refuse, at)])];
  const candidates = offsets.map((o) => ms - o).filter((t) => offsetAt(zone.name, t, refuse, at) === ms - t).sort((a, b) => a - b);
  if (strict && candidates.length === 0) refuse(DiagnosticCode.valueTypeConflict, `Local time ${describe(local)} does not exist in timezone ${zone.name}.`, at);
  if (strict && candidates.length > 1) refuse(DiagnosticCode.valueTypeConflict, `Local time ${describe(local)} is ambiguous in timezone ${zone.name}.`, at);
  // In a gap, the offset BEFORE it: the local time comes out advanced by the gap.
  const instant = candidates[0] ?? ms - offsetAt(zone.name, ms - 86_400_000, refuse, at);
  return normalise({ days: Math.floor(instant / 86_400_000), nanos: BigInt(((instant % 86_400_000) + 86_400_000) % 86_400_000) * NANOS_PER_MS + subMs(local) });
}

function toLocal(instant: Naive, zone: Zone, refuse: Refuse, at: Range | undefined): Naive {
  const offset = zone.kind === 'offset' ? zone.minutes * 60_000 : offsetAt(zone.name, localMs(instant), refuse, at);
  return normalise({ days: instant.days, nanos: instant.nanos + BigInt(offset) * NANOS_PER_MS });
}

// ── arithmetic ───────────────────────────────────────────────────────────────

const addMonths = (naive: Naive, months: number): Naive => {
  const { year, month, day } = civilFromDays(naive.days);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return { days: daysFromCivil(y, m, Math.min(day, daysInMonth(y, m))), nanos: naive.nanos };
};

const compareNaive = (a: Naive, b: Naive): number => (a.days !== b.days ? a.days - b.days : a.nanos < b.nanos ? -1 : a.nanos > b.nanos ? 1 : 0);

/** The calendar difference `later − earlier`: whole months, then days, then the clock. */
function difference(later: Naive, earlier: Naive, refuse: Refuse, at: Range | undefined): Duration {
  if (compareNaive(later, earlier) < 0) return refuse(DiagnosticCode.valueOutOfRange, 'A duration cannot be negative: the earlier value is subtracted from the later one.', at);
  const a = civilFromDays(later.days);
  const b = civilFromDays(earlier.days);
  let months = (a.year - b.year) * 12 + (a.month - b.month);
  let anchor = addMonths(earlier, months);
  while (months > 0 && compareNaive(anchor, later) > 0) anchor = addMonths(earlier, (months -= 1));
  const remainder = BigInt(later.days - anchor.days) * NANOS_PER_DAY + (later.nanos - anchor.nanos);
  return checkDuration({ months, days: Number(remainder / NANOS_PER_DAY), nanos: remainder % NANOS_PER_DAY }, refuse, at);
}

/** Add (`sign` 1) or subtract (`sign` −1) a duration: the calendar in local time, then the clock exactly. */
function shift(naive: Naive, duration: Duration, sign: 1 | -1, zone: Zone | undefined, refuse: Refuse, at: Range | undefined): Naive {
  const calendar = (n: Naive): Naive => {
    const moved = addMonths(n, sign * duration.months);
    return { days: moved.days + sign * duration.days, nanos: moved.nanos };
  };
  const clock = (n: Naive): Naive => normalise({ days: n.days, nanos: n.nanos + BigInt(sign) * duration.nanos });
  if (zone === undefined) return checkRange(sign === 1 ? clock(calendar(naive)) : calendar(clock(naive)), refuse, at);
  // Zoned: the calendar moves the wall clock, the clock moves the instant.
  if (sign === 1) {
    const instant = toInstant(calendar(naive), zone, false, refuse, at);
    return checkRange(toLocal(clock(instant), zone, refuse, at), refuse, at);
  }
  const instant = clock(toInstant(naive, zone, false, refuse, at));
  return checkRange(calendar(toLocal(instant, zone, refuse, at)), refuse, at);
}

export interface TemporalValue {
  readonly valueType: 'date' | 'datetime' | 'datetime-tz' | 'duration';
  readonly text: string;
}

/** A temporal literal, checked and in its one stored spelling — what reading or writing one needs. */
export function canonicalTemporal(valueType: string, text: string, refuse: Refuse, at: Range | undefined): string {
  switch (valueType) {
    case 'duration':
      return formatDuration(parseDuration(text, refuse, at));
    case 'date': {
      const { naive } = parseNaive(text, refuse, at);
      return formatDate(naive.days);
    }
    case 'datetime': {
      const { naive } = parseNaive(text, refuse, at);
      return formatNaive(naive);
    }
    case 'datetime-tz': {
      const { naive, rest } = parseNaive(text, refuse, at);
      const zone = parseZone(rest, refuse, at);
      if (zone === undefined) return refuse(DiagnosticCode.valueTypeConflict, `'${text}' has no time zone.`, at);
      toInstant(naive, zone, true, refuse, at);
      const local = formatNaive(naive);
      return zone.kind === 'offset' ? `${local}${zone.minutes === 0 ? 'Z' : zone.text}` : `${local} ${zone.name}`;
    }
    default:
      return text;
  }
}

/** The instant a zoned datetime names, as comparable text — what two `datetime-tz` values are equal by. */
export function instantOf(text: string, refuse: Refuse = (_c, message) => { throw new Error(message); }): string {
  const { naive, rest } = parseNaive(text, refuse, undefined);
  const zone = parseZone(rest, refuse, undefined) ?? { kind: 'offset', minutes: 0, text: 'Z' };
  return formatNaive(toInstant(naive, zone, false, refuse, undefined));
}

/** The result type of `left op right`, or `undefined` when TypeDB has no such operator. */
export function temporalResultType(operator: string, left: string, right: string): TemporalValue['valueType'] | undefined {
  if (operator !== '+' && operator !== '-') return undefined;
  const point = (t: string): boolean => t === 'date' || t === 'datetime' || t === 'datetime-tz';
  if (point(left) && right === 'duration') return left as TemporalValue['valueType'];
  if (left === 'duration' && right === 'duration') return 'duration';
  if (operator === '+' && left === 'duration' && point(right)) return right as TemporalValue['valueType'];
  if (operator === '-' && (left === 'date' || left === 'datetime') && (right === 'date' || right === 'datetime')) return 'duration';
  if (operator === '-' && left === 'datetime-tz' && right === 'datetime-tz') return 'duration';
  return undefined;
}

/** `left op right` over temporal values — see the module comment for what each operator means. */
export function temporalArithmetic(operator: string, left: TemporalValue, right: TemporalValue, refuse: Refuse, at: Range | undefined): TemporalValue {
  const result = temporalResultType(operator, left.valueType, right.valueType);
  if (result === undefined) return refuse(DiagnosticCode.valueTypeConflict, `There is no '${operator}' for a ${left.valueType} and a ${right.valueType}.`, at);
  const sign = operator === '+' ? 1 : -1;
  if (left.valueType === 'duration' && right.valueType === 'duration') {
    const [a, b] = [parseDuration(left.text, refuse, at), parseDuration(right.text, refuse, at)];
    return { valueType: 'duration', text: formatDuration(checkDuration({ months: a.months + sign * b.months, days: a.days + sign * b.days, nanos: a.nanos + BigInt(sign) * b.nanos }, refuse, at)) };
  }
  if (right.valueType === 'duration' || left.valueType === 'duration') {
    const [point, by] = right.valueType === 'duration' ? [left, right] : [right, left];
    const duration = parseDuration(by.text, refuse, at);
    const { naive, rest } = parseNaive(point.text, refuse, at);
    const zone = point.valueType === 'datetime-tz' ? parseZone(rest, refuse, at) : undefined;
    if (point.valueType === 'date' && duration.nanos !== BigInt(0)) {
      return refuse(DiagnosticCode.valueTypeConflict, `A date moves by whole days: '${by.text}' has a time part.`, at);
    }
    const moved = shift(naive, duration, sign, zone, refuse, at);
    if (point.valueType === 'date') return { valueType: 'date', text: formatDate(moved.days) };
    if (zone === undefined) return { valueType: 'datetime', text: formatNaive(moved) };
    return { valueType: 'datetime-tz', text: `${formatNaive(moved)}${zone.kind === 'offset' ? zone.text : ` ${zone.name}`}` };
  }
  // A difference: as instants for zoned values, as naive values (a date at midnight) otherwise.
  const naiveOf = (value: TemporalValue): Naive => {
    const { naive, rest } = parseNaive(value.text, refuse, at);
    const zone = value.valueType === 'datetime-tz' ? parseZone(rest, refuse, at) : undefined;
    return zone === undefined ? naive : toInstant(naive, zone, false, refuse, at);
  };
  return { valueType: 'duration', text: formatDuration(difference(naiveOf(left), naiveOf(right), refuse, at)) };
}

export { zoneText };
