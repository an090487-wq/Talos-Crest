export function parseLineNumber(value: string, lineCount: number): number | null {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > lineCount) return null;
  return parsed;
}
