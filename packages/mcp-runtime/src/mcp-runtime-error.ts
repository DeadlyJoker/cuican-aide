export class McpRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "McpRuntimeError";
    this.code = code;
  }
}
