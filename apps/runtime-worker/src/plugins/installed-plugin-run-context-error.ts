export class InstalledPluginRunContextError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "InstalledPluginRunContextError";
    this.code = code;
  }
}
