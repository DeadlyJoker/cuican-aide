export class RuntimeWorkspaceError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly certainty: "notSent" | "possiblySent";

  constructor(
    code: string,
    options: Readonly<{
      retryable?: boolean;
      certainty?: "notSent" | "possiblySent";
      cause?: unknown;
    }> = {},
  ) {
    super(code, { cause: options.cause });
    this.name = "RuntimeWorkspaceError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.certainty = options.certainty ?? "notSent";
  }
}
