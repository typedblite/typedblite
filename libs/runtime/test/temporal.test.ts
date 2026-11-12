import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { canonicalTemporal, formatDuration, instantOf, parseDuration, temporalArithmetic, type TemporalValue } from '../src/temporal.js';

/**
 * Temporal arithmetic as TypeDB does it — expression.feature L492–L850 is the acceptance suite; this
 * pins the calendar rules each answer rests on.
 */
const fail = (_code: unknown, message: string): never => {
  throw new Error(message);
};
const v = (valueType: TemporalValue['valueType'], text: string): TemporalValue => ({ valueType, text });
const op = (operator: string, left: TemporalValue, right: TemporalValue): string => temporalArithmetic(operator, left, right, fail, undefined).text;

describe('temporal values', () => {
  it('a difference is calendar months, then days, then the clock — L492, L534', () => {
    assert.equal(op('-', v('date', '2027-03-30'), v('date', '2026-01-27')), 'P1Y2M3D');
    assert.equal(op('-', v('datetime', '2027-03-30T16:05:06.789'), v('datetime', '2026-01-27T12:00:00')), 'P1Y2M3DT4H5M6.789S');
  });

  it('adding months clamps to the month’s length', () => {
    assert.equal(op('+', v('date', '2024-01-31'), v('duration', 'P1M')), '2024-02-29');
  });

  it('durations are months, days and exact time, never negative — L810, L837', () => {
    assert.equal(op('-', v('duration', 'P9Y8M7DT6H5M3.210S'), v('duration', 'P1Y2M3DT4H5M6.789S')), 'P8Y6M4DT1H59M56.421S');
    assert.equal(formatDuration(parseDuration('P66W', fail, undefined)), 'P462D');
    assert.equal(formatDuration(parseDuration('PT90M', fail, undefined)), 'PT1H30M');
    assert.equal(formatDuration(parseDuration('PT5.5S', fail, undefined), true), 'PT5.500000000S');
    assert.throws(() => op('-', v('duration', 'PT0S'), v('duration', 'PT1S')), /cannot be negative/);
  });

  it('in a named zone, P1D keeps the wall clock and PT24H does not — L746, L760', () => {
    assert.equal(op('+', v('datetime-tz', '2024-03-30T12:00:00 Europe/London'), v('duration', 'P1D')), '2024-03-31T12:00:00 Europe/London');
    assert.equal(op('+', v('datetime-tz', '2024-03-30T12:00:00 Europe/London'), v('duration', 'PT24H')), '2024-03-31T13:00:00 Europe/London');
  });

  it('a gap is advanced by its length, an overlap is the earlier instant — L773, L786', () => {
    assert.equal(op('+', v('datetime-tz', '2024-03-30T01:30:00 Europe/London'), v('duration', 'P1D')), '2024-03-31T02:30:00 Europe/London');
    assert.equal(instantOf(op('+', v('datetime-tz', '2024-10-26T01:30:00 Europe/London'), v('duration', 'P1D'))), instantOf('2024-10-27T01:30:00+01:00'));
    assert.equal(op('+', v('datetime-tz', '2011-12-29T12:00:00 Pacific/Apia'), v('duration', 'P1D')), '2011-12-31T12:00:00 Pacific/Apia');
  });

  it('a zoned literal in a gap or an overlap is refused; zoned values are equal by instant — L728, L627', () => {
    assert.throws(() => canonicalTemporal('datetime-tz', '2024-03-31T01:30:00 Europe/London', fail, undefined), /does not exist in timezone Europe\/London/);
    assert.throws(() => canonicalTemporal('datetime-tz', '2024-10-27T01:30:00 Europe/London', fail, undefined), /is ambiguous in timezone Europe\/London/);
    assert.equal(instantOf('2026-01-27T12:00:00 Europe/London'), instantOf('2026-01-27T12:00:00+00:00'));
  });

  it('years run from -262143 to +262142 — L506, L692', () => {
    assert.equal(op('-', v('date', '+262142-12-31'), v('date', '-262143-01-01')), 'P524285Y11M30D');
    assert.throws(() => canonicalTemporal('datetime', '+262143-01-01T00:00:00', fail, undefined), /Invalid date/);
  });
});
