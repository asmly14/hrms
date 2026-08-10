/**
 * Numeric-input helper shared by the Settings + Company Setup sections.
 * Lives outside shared.tsx so that module exports only components
 * (react-refresh/only-export-components).
 */

/** Parses a number input value, falling back when blank / non-numeric. */
export function numOr(value: string, fallback: number): number {
  // Number('') === 0 — a cleared field must hit the fallback, not save 0.
  if (value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
