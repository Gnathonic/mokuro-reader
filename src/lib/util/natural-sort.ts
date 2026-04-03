/**
 * Deterministic natural sort for filenames.
 *
 * Unlike localeCompare with `numeric: true`, this produces consistent results
 * across all browsers and locales. Characters are compared by code point so
 * special characters like `#` (U+0023) always sort before digits (U+0030+).
 * Consecutive digit runs are compared numerically so page2 < page10.
 */

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

export function naturalSort(a: string, b: string): number {
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const ca = a[i];
    const cb = b[j];

    if (isDigit(ca) && isDigit(cb)) {
      // Compare numeric runs as integers
      let numA = 0;
      while (i < a.length && isDigit(a[i])) {
        numA = numA * 10 + (a.charCodeAt(i) - 48);
        i++;
      }
      let numB = 0;
      while (j < b.length && isDigit(b[j])) {
        numB = numB * 10 + (b.charCodeAt(j) - 48);
        j++;
      }
      if (numA !== numB) return numA - numB;
    } else {
      // Compare by code point
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      i++;
      j++;
    }
  }

  return a.length - b.length;
}
