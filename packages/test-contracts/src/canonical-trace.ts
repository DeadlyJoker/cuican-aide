import { isDeepStrictEqual } from "node:util";

export type TraceJson =
  | string
  | number
  | boolean
  | null
  | TraceJson[]
  | TraceObject;
export type TraceObject = { [key: string]: TraceJson };

export type TraceEvent = Readonly<{
  schemaVersion: string;
  sequence: number;
  type: string;
  identity: Readonly<TraceObject>;
  data: Readonly<TraceObject>;
  eventId?: string;
  occurredAt?: string;
  requestId?: string;
  traceId?: string;
}>;

export type CanonicalTrace = Readonly<{
  schemaVersion: "crewon.trace.v0";
  caseId: string;
  events: readonly TraceEvent[];
  finalState: Readonly<TraceObject>;
}>;

export type StableTrace = Readonly<{
  schemaVersion: "crewon.trace.v0";
  caseId: string;
  events: readonly Readonly<{
    schemaVersion: string;
    sequence: number;
    type: string;
    identity: Readonly<TraceObject>;
    data: Readonly<TraceObject>;
  }>[];
  finalState: Readonly<TraceObject>;
}>;

export type TraceComparison =
  | Readonly<{ equal: true }>
  | Readonly<{ equal: false; expected: string; actual: string }>;

export function stabilizeTrace(trace: CanonicalTrace): StableTrace {
  validateTrace(trace);
  return {
    schemaVersion: trace.schemaVersion,
    caseId: trace.caseId,
    events: trace.events.map(
      ({ schemaVersion, sequence, type, identity, data }) => ({
        schemaVersion,
        sequence,
        type,
        identity: canonicalizeObject(identity),
        data: canonicalizeObject(data),
      }),
    ),
    finalState: canonicalizeObject(trace.finalState),
  };
}

export function compareTraces(
  expected: CanonicalTrace,
  actual: CanonicalTrace,
): TraceComparison {
  const stableExpected = stabilizeTrace(expected);
  const stableActual = stabilizeTrace(actual);
  if (isDeepStrictEqual(stableExpected, stableActual)) {
    return { equal: true };
  }
  return {
    equal: false,
    expected: JSON.stringify(stableExpected, null, 2),
    actual: JSON.stringify(stableActual, null, 2),
  };
}

function validateTrace(trace: CanonicalTrace): void {
  if (trace.schemaVersion !== "crewon.trace.v0" || trace.caseId.length === 0) {
    throw new TypeError("trace_identity_invalid");
  }
  let previousSequence = 0;
  for (const event of trace.events) {
    if (event.sequence !== previousSequence + 1) {
      throw new TypeError("trace_sequence_gap");
    }
    if (event.schemaVersion.length === 0 || event.type.length === 0) {
      throw new TypeError("trace_event_type_invalid");
    }
    canonicalizeObject(event.identity);
    canonicalizeObject(event.data);
    previousSequence = event.sequence;
  }
  canonicalizeObject(trace.finalState);
}

function canonicalizeObject(value: Readonly<TraceObject>): TraceObject {
  const result: TraceObject = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) {
      throw new TypeError("trace_undefined_invalid");
    }
    result[key] = canonicalize(item);
  }
  return result;
}

function canonicalize(value: TraceJson): TraceJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("trace_number_invalid");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== "object") {
    throw new TypeError("trace_value_invalid");
  }

  return canonicalizeObject(value);
}
