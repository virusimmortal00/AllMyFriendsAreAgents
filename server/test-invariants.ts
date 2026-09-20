export function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing test fixture: ${label}.`);
  return value;
}

export function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  return requiredValue(values.at(index), label);
}
