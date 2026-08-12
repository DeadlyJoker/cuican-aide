import { protocolError } from "./responses-errors.ts";

export const TURN_STATE_HEADER = "x-codex-turn-state";
export const MAX_TURN_STATE_BYTES = 4 * 1024;
export const MAX_TURN_STATE_RUNS = 64;

export class ResponsesTurnStateAuthority {
  readonly #states = new Map<string, string>();

  get(runId: string): string | null {
    return this.#states.get(runId) ?? null;
  }

  observe(runId: string, values: readonly string[]): void {
    const value = parseTurnStateHeader(values);
    if (value === null) return;
    const current = this.#states.get(runId);
    if (current !== undefined && current !== value) {
      throw protocolError("responses_turn_state_conflict");
    }
    if (current === undefined && this.#states.size >= MAX_TURN_STATE_RUNS) {
      throw protocolError("responses_turn_state_capacity_exceeded");
    }
    this.#states.set(runId, value);
  }
}

export function parseTurnStateHeader(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw protocolError("responses_turn_state_duplicate");
  }
  const value = values[0]!;
  if (
    value.length === 0 ||
    value.length > MAX_TURN_STATE_BYTES ||
    /[^\x20-\x2b\x2d-\x7e]/u.test(value)
  ) {
    throw protocolError("responses_turn_state_invalid");
  }
  return value;
}

export function fetchTurnStateHeaders(headers: Headers): readonly string[] {
  const value = headers.get(TURN_STATE_HEADER);
  return value === null ? [] : [value];
}
