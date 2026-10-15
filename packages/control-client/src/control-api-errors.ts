import type { ErrorCategory } from "@crewon/contracts";

/** A request failed before an HTTP response; it is not a business rejection or evidence of revocation. */
export class ControlApiTransportError extends Error {
  constructor(cause: unknown) {
    super("control_api_transport_unavailable", { cause });
    this.name = "ControlApiTransportError";
  }
}

export class ControlApiClientError extends Error {
  readonly status: number;
  readonly category: ErrorCategory;
  readonly code: string;
  readonly requestId: string;

  constructor(input: {
    status: number;
    category: ErrorCategory;
    code: string;
    requestId: string;
  }) {
    super(input.code);
    this.name = "ControlApiClientError";
    this.status = input.status;
    this.category = input.category;
    this.code = input.code;
    this.requestId = input.requestId;
  }
}

export class ControlApiProtocolError extends Error {
  readonly code: string;
  /** Transport metadata only. A malformed body is still rejected as a protocol error. */
  readonly httpStatus: number | undefined;

  constructor(code: string, options?: Readonly<{ httpStatus: number }>) {
    super(code);
    this.name = "ControlApiProtocolError";
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }
}
