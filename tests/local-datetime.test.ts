import { parseLocalDateTime } from '../src/utils/local-datetime';

describe('parseLocalDateTime', () => {
  it('converts a browser-local time to UTC using the browser offset', () => {
    // New York in summer is UTC-4 => getTimezoneOffset() === 240
    expect(parseLocalDateTime('2030-07-01T09:30', '240')!.toISOString()).toBe('2030-07-01T13:30:00.000Z');
    // Berlin in summer is UTC+2 => -120
    expect(parseLocalDateTime('2030-07-01T09:30', '-120')!.toISOString()).toBe('2030-07-01T07:30:00.000Z');
    // UTC
    expect(parseLocalDateTime('2030-07-01T09:30', '0')!.toISOString()).toBe('2030-07-01T09:30:00.000Z');
  });

  it('accepts seconds and numeric offsets', () => {
    expect(parseLocalDateTime('2030-01-01T00:00:30', 0)!.toISOString()).toBe('2030-01-01T00:00:30.000Z');
  });

  it('crosses date boundaries correctly', () => {
    expect(parseLocalDateTime('2030-12-31T23:30', '-60')!.toISOString()).toBe('2030-12-31T22:30:00.000Z');
    expect(parseLocalDateTime('2030-12-31T23:30', '120')!.toISOString()).toBe('2031-01-01T01:30:00.000Z');
  });

  it('falls back to server-local parsing without a valid offset', () => {
    const fallback = parseLocalDateTime('2030-07-01T09:30')!;
    expect(fallback.getTime()).toBe(new Date('2030-07-01T09:30').getTime());
    expect(parseLocalDateTime('2030-07-01T09:30', 'banana')!.getTime()).toBe(new Date('2030-07-01T09:30').getTime());
    expect(parseLocalDateTime('2030-07-01T09:30', '99999')!.getTime()).toBe(new Date('2030-07-01T09:30').getTime());
  });

  it('rejects empty, garbage and impossible dates', () => {
    expect(parseLocalDateTime('', '0')).toBeNull();
    expect(parseLocalDateTime(undefined, '0')).toBeNull();
    expect(parseLocalDateTime('not a date', '0')).toBeNull();
    expect(parseLocalDateTime('2030-02-31T10:00', '0')).toBeNull();
  });
});
