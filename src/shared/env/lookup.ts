export type Lookup = (key: string) => string | undefined;

export function map(values: Readonly<Record<string, string>>): Lookup {
  const owned = new Map(Object.entries(values));
  return (key) => owned.get(key);
}
