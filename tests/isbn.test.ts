import { describe, expect, it } from 'vitest';
import { isValidIsbn, normalizeIsbn, toIsbn13 } from '../shared/isbn';

describe('ISBN validation', () => {
  it.each([
    '9780306406157',
    '9780743273565',
    '9790000000001',
    '0306406152',
    '080442957X',
  ])('accepts a correctly formatted book identifier: %s', (isbn) => {
    expect(isValidIsbn(isbn)).toBe(true);
  });

  it.each([
    '', '9780306406158', '4006381333931', '9771234567003', '978030640615',
    'ISBN 9780306406157', '978O306406157', '0804429571', 'X804429570',
    '12345678901234567890',
  ])('rejects invalid identifiers without attempting to repair them: %s', (isbn) => {
    expect(isValidIsbn(isbn)).toBe(false);
    expect(toIsbn13(isbn)).toBeNull();
  });

  it('normalizes separators and a lowercase X without discarding other characters', () => {
    expect(normalizeIsbn(' 0–8044–2957–x ')).toBe('080442957X');
    expect(normalizeIsbn('978\u00a0030 6406157')).toBe('9780306406157');
    expect(normalizeIsbn('978O306406157')).toBe('978O306406157');
    expect(normalizeIsbn(null)).toBe('');
  });

  it('converts valid ISBN-10 codes and preserves ISBN-13 codes', () => {
    expect(toIsbn13('0-306-40615-2')).toBe('9780306406157');
    expect(toIsbn13('080442957X')).toBe('9780804429573');
    expect(toIsbn13('9780743273565')).toBe('9780743273565');
  });
});
