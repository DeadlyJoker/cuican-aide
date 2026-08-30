export class ContractValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ContractValidationError";
    this.code = code;
  }
}
