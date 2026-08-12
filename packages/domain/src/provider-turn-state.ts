export const MAX_PROVIDER_TURN_STATE_BYTES = 4 * 1024;

/** Validates opaque Run-private provider control state without exposing it publicly. */
export function validateProviderTurnState(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_TURN_STATE_BYTES ||
    /[^\x20-\x2b\x2d-\x7e]/u.test(value)
  ) {
    throw new ProviderTurnStateError();
  }
  return value;
}

export class ProviderTurnStateError extends Error {
  constructor() {
    super("provider_turn_state_invalid");
    this.name = "ProviderTurnStateError";
  }
}
