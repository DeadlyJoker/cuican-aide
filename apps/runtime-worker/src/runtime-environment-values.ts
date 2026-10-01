export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function requiredEnvironment(
  name: string,
  environment: RuntimeEnvironment = process.env,
): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

export function environmentOr(
  name: string,
  fallback: string,
  environment: RuntimeEnvironment = process.env,
): string {
  return environment[name]?.trim() || fallback;
}

export function parsePositiveInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

export function parseNonNegativeInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}
