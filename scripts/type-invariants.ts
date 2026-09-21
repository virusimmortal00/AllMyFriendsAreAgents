export function requiredValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing script invariant: ${label}.`);
  return value;
}

export function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  return requiredValue(values.at(index), label);
}
