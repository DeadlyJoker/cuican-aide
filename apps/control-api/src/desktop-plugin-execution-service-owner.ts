import {
  PluginExecutionRegistry,
  capturePluginNodeHostServiceCatalog,
  createPluginExecutionHostServiceRegistration,
} from "@crewon/plugin-host";

/** Installation setup registration only; Worker execution owns its separate Run graph. */
export class DesktopPluginExecutionServiceOwner {
  readonly #registry = new PluginExecutionRegistry();
  readonly catalog = capturePluginNodeHostServiceCatalog([
    createPluginExecutionHostServiceRegistration(this.#registry),
  ]);

  /** Revokes factories without closing any caller-owned ToolRuntime. */
  close(): void {
    this.#registry.close();
  }
}
