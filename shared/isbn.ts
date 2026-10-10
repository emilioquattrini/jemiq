/** Remove presentation separators only; never silently repair OCR characters. */
export function normalizeIsbn(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\s\u00a0\u2010-\u2015-]/gu, '').toUpperCase();
}

export function isValidIsbn(value: string | null | undefined): boolean {
  const isbn = normalizeIsbn(value);
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const checksum = [...isbn].reduce(
      (sum, character, index) => sum + (character === 'X' ? 10 : Number(character)) * (10 - index),
      0,
    );
    return checksum % 11 === 0;
  }
  if (!/^97[89]\d{10}$/.test(isbn)) return false;
  return [...isbn].reduce(
    (sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 1 : 3),
    0,
  ) % 10 === 0;
}

/** Return a valid ISBN-13, or null. Invalid ISBNs are never "fixed". */
export function toIsbn13(value: string | null | undefined): string | null {
  if (!isValidIsbn(value)) return null;
  const isbn = normalizeIsbn(value);
  if (isbn.length === 13) return isbn;
  const prefix = '978' + isbn.slice(0, 9);
  const sum = [...prefix].reduce(
    (total, character, index) => total + Number(character) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return prefix + ((10 - sum % 10) % 10);
}
