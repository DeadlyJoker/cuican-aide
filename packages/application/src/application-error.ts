export type ApplicationErrorCategory =
  | "authorization"
  | "notFound"
  | "conflict"
  | "validation"
  | "internal";

export class ApplicationError extends Error {
  readonly category: ApplicationErrorCategory;
  readonly code: string;

  constructor(
    category: ApplicationErrorCategory,
    code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ApplicationError";
    this.category = category;
    this.code = code;
  }
}
