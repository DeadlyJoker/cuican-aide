export function removeRecordKey<T>(
  current: Record<string, T>,
  key: string,
): Record<string, T> {
  const { [key]: _removed, ...next } = current;
  return next;
}
