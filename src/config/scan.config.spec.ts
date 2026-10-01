import {
  parseBool,
  parseNonNegativeInt,
  parsePositiveInt,
} from './scan.config';

describe('scan config parsers', () => {
  it('parsePositiveInt falls back on junk, zero and negatives', () => {
    expect(parsePositiveInt('4', 9)).toBe(4);
    expect(parsePositiveInt(' 12 ', 9)).toBe(12);
    for (const bad of [undefined, '', 'x', '0', '-3'])
      expect(parsePositiveInt(bad, 9)).toBe(9);
  });
  it('parseNonNegativeInt keeps 0 (unlimited drafts)', () => {
    expect(parseNonNegativeInt('0', 5)).toBe(0);
    expect(parseNonNegativeInt('-1', 5)).toBe(5);
  });
  it('parseBool understands common spellings', () => {
    expect(parseBool('TRUE', false)).toBe(true);
    expect(parseBool('off', true)).toBe(false);
    expect(parseBool('maybe', true)).toBe(true);
  });
});
