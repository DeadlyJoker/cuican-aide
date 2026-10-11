import { PluginTaskActionBridge } from "./plugin-task-action-bridge.ts";
import { PluginProjectGenerationExecutionBridge } from "./plugin-project-generation-execution-bridge.ts";
import { PluginProjectGenerationQueryExecutionBridge } from "./plugin-project-generation-query-execution-bridge.ts";
import { PluginProjectHistoricalQueryExecutionBridge } from "./plugin-project-historical-query-execution-bridge.ts";
import type { PluginHostService } from "./plugin-node-host.ts";
import {
  bridgeFailure,
  bridgeFields,
} from "./plugin-task-action-bridge-support.ts";

type ProjectBridge =
  | PluginProjectGenerationExecutionBridge
  | PluginProjectGenerationQueryExecutionBridge
  | PluginProjectHistoricalQueryExecutionBridge;
type Bridge = PluginTaskActionBridge | ProjectBridge;
type Port = Readonly<{
  createTask(input: unknown): unknown;
  queryTask?(input: unknown): unknown;
}>;

/** One original task service namespace; only a bridge's privately issued reference chooses its authority. */
export class PluginTaskInvocationRouter {
  readonly #bridges: readonly Bridge[];
  constructor(
    input: Readonly<{
      ordinary: PluginTaskActionBridge;
      projects: readonly ProjectBridge[];
    }>,
  ) {
    const fields = bridgeFields(input, ["ordinary", "projects"]);
    const ordinary = fields.ordinary;
    const projects = fields.projects;
    if (
      !PluginTaskActionBridge.isOwner(ordinary) ||
      Object.getPrototypeOf(ordinary) !== PluginTaskActionBridge.prototype ||
      !Array.isArray(projects) ||
      Object.getPrototypeOf(projects) !== Array.prototype ||
      projects.length > 3 ||
      Reflect.ownKeys(projects).length !== projects.length + 1
    )
      bridgeFailure("plugin_task_router_invalid");
    const captured: ProjectBridge[] = [];
    for (let index = 0; index < projects.length; index++) {
      const field = Object.getOwnPropertyDescriptor(projects, String(index));
      if (!field || !Object.hasOwn(field, "value") || !field.enumerable)
        bridgeFailure("plugin_task_router_invalid");
      const bridge: unknown = field.value;
      const valid =
        (PluginProjectGenerationExecutionBridge.isOwner(bridge) &&
          Object.getPrototypeOf(bridge) ===
            PluginProjectGenerationExecutionBridge.prototype) ||
        (PluginProjectGenerationQueryExecutionBridge.isOwner(bridge) &&
          Object.getPrototypeOf(bridge) ===
            PluginProjectGenerationQueryExecutionBridge.prototype) ||
        (PluginProjectHistoricalQueryExecutionBridge.isOwner(bridge) &&
          Object.getPrototypeOf(bridge) ===
            PluginProjectHistoricalQueryExecutionBridge.prototype);
      if (!valid) bridgeFailure("plugin_task_router_invalid");
      captured.push(bridge as ProjectBridge);
    }
    const bridges = [ordinary, ...captured];
    if (new Set(bridges).size !== bridges.length)
      bridgeFailure("plugin_task_router_invalid");
    this.#bridges = Object.freeze(bridges);
  }
  hostService(apiVersion: "1" | "2"): PluginHostService {
    if (apiVersion !== "1" && apiVersion !== "2")
      bridgeFailure("plugin_task_router_api_version_invalid");
    return Object.freeze<PluginHostService>({
      service: "crewon.tasks",
      apiVersion,
      value: Object.freeze({
        createTask: () => bridgeFailure("plugin_task_port_unbound"),
        ...(apiVersion === "2"
          ? { queryTask: () => bridgeFailure("plugin_task_port_unbound") }
          : {}),
      }),
      bindForPlugin: (identity, lifecycle) => {
        const ports = this.#bridges.map(
          (bridge) =>
            (apiVersion === "1" ? bridge.hostService() : bridge.hostServiceV2())
              .bindForPlugin!(identity, lifecycle) as Port,
        );
        const route = (input: unknown): Port => {
          const matches = this.#bridges.flatMap((bridge, index) =>
            bridge.ownsInvocation(input) ? [index] : [],
          );
          if (matches.length > 1)
            bridgeFailure("plugin_invocation_owner_conflict");
          return ports[matches[0] ?? 0]!;
        };
        return Object.freeze({
          createTask: (input: unknown) => route(input).createTask(input),
          ...(apiVersion === "2"
            ? { queryTask: (input: unknown) => route(input).queryTask!(input) }
            : {}),
        });
      },
    });
  }
}
