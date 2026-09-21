export const validKey = (value: string): boolean =>
  /^[A-Z][A-Z0-9_]*$/.test(value);

export function integer(value: string): number | undefined {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
