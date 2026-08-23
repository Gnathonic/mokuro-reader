/**
 * The size of a volume's archive, for a card or a list row.
 *
 * Deliberately not `formatBytes` (`$lib/util/upload`), which is the general
 * storage formatter: it prints a fixed number of decimals at every scale and
 * ranges from bytes to yottabytes. A download size is read at a glance and
 * compared roughly, so the rule here is different — one decimal only while it
 * still says something ("1.5 GB", "5.2 MB"), none once the number is big
 * enough that it does not ("184 MB"), and never a unit smaller than KB.
 *
 * Returns '' for a size that is not a real measurement, so a caller can render
 * it unconditionally without printing "0 KB" over a volume nobody has measured.
 */
const UNITS = ['KB', 'MB', 'GB', 'TB'];

export function formatArchiveSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';

  let value = bytes / 1024;
  let unit = 0;
  // `1023.5` rather than `1024`: anything from there up ROUNDS to 1024, which is
  // not a number this scale prints — it is the next unit.
  while (value >= 1023.5 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // `9.97` would round to "10.0" and read as a decimal that isn't wanted at
  // that size, so the cut is taken on the ROUNDED value, not the raw one.
  const shown = value < 9.95 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${UNITS[unit]}`;
}
