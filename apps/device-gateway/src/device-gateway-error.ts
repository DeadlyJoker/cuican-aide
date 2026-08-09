export class DeviceGatewayError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "DeviceGatewayError";
    this.code = code;
  }
}
