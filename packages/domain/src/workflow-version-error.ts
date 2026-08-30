export class WorkflowVersionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "WorkflowVersionError";
    this.code = code;
  }
}
