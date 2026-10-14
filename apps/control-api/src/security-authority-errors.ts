/** Internal transport evidence. Neither an unavailable authority nor an invalid response grants identity. */
export class SecurityAuthorityVerificationError extends Error {
  readonly kind: "unavailable" | "rejected" | "invalidResponse";
  readonly httpStatus: number | undefined;

  constructor(
    kind: SecurityAuthorityVerificationError["kind"],
    options?: ErrorOptions & Readonly<{ httpStatus?: number }>,
  ) {
    super("identity_authority_unavailable", options);
    this.name = "SecurityAuthorityVerificationError";
    this.kind = kind;
    this.httpStatus = options?.httpStatus;
  }
}

export class SecurityAuthorityTimeoutError extends Error {
  constructor() {
    super("security_authority_timeout");
    this.name = "SecurityAuthorityTimeoutError";
  }
}
