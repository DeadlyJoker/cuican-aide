import type {
  PluginRetainedToolExecutionResultLookup,
  PluginToolExecutionCommand,
  PluginToolExecutionResolution,
  PluginToolExecutionResultAcknowledgement,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import { canonical } from "./catalog.js";

/** Bounded local COMMIT-to-ACK evidence. Durable external operations are never removed by an ACK. */
export class RetainedResults {
  readonly #context: PluginToolRuntimeContext;
  readonly #values = new Map<
    string,
    {
      command: PluginToolExecutionCommand;
      resolution: PluginToolExecutionResolution;
    }
  >();
  #offset = 0;
  constructor(context: PluginToolRuntimeContext) {
    this.#context = context;
  }
  get size(): number {
    return this.#values.size;
  }

  prepare(
    command: PluginToolExecutionCommand,
  ): PluginToolExecutionResolution | null {
    const value = this.#values.get(command.executionId);
    if (
      value &&
      (!this.#matches(value.command, command) ||
        value.command.callId !== command.callId ||
        value.command.input !== command.input ||
        value.command.runId !== command.runId ||
        value.command.kind !== command.kind ||
        value.command.name !== command.name)
    )
      throw new Error("krea_plugin_execution_conflict");
    if (!value && this.#values.size >= 32)
      throw new Error("krea_plugin_retained_capacity_exceeded");
    return value?.resolution ?? null;
  }
  retain(
    command: PluginToolExecutionCommand,
    resolution: PluginToolExecutionResolution,
  ): PluginToolExecutionResolution {
    if (resolution.status === "completed") Object.freeze(resolution.result);
    Object.freeze(resolution);
    this.#values.set(command.executionId, {
      command: Object.freeze(structuredClone(command)),
      resolution,
    });
    return resolution;
  }
  acknowledge(ack: PluginToolExecutionResultAcknowledgement): boolean {
    const value = this.#values.get(ack.executionId);
    if (
      !value ||
      !this.#matches(value.command, ack) ||
      ack.status !== value.resolution.status ||
      ack.providerReceiptId !== value.resolution.providerReceiptId
    )
      return false;
    this.#values.delete(ack.executionId);
    return true;
  }
  read(
    lookup: PluginRetainedToolExecutionResultLookup,
  ): PluginToolExecutionResolution | null {
    const value = this.#values.get(lookup.executionId);
    return value && this.#matches(value.command, lookup)
      ? value.resolution
      : null;
  }
  query(runId: string, limit: number) {
    this.#limit(limit);
    if (runId !== this.#context.run.runId) return [];
    return [...this.#values.values()]
      .slice(0, limit)
      .map(({ command, resolution }) => this.#metadata(command, resolution));
  }
  scan(limit: number) {
    this.#limit(limit);
    const values = [...this.#values.values()];
    const offset = values.length ? this.#offset % values.length : 0;
    const page = [...values.slice(offset), ...values.slice(0, offset)].slice(
      0,
      limit,
    );
    if (values.length) this.#offset = (offset + page.length) % values.length;
    return page.map(({ command, resolution }) =>
      Object.freeze({
        ...this.#metadata(command, resolution),
        tenantId: this.#context.scope.tenantId,
        runId: command.runId,
      }),
    );
  }
  clear(): void {
    this.#values.clear();
  }
  #metadata(
    command: PluginToolExecutionCommand,
    resolution: PluginToolExecutionResolution,
  ) {
    return Object.freeze({
      executionId: command.executionId,
      idempotencyKey: command.idempotencyKey,
      actionDigest: command.actionDigest,
      kind: command.kind,
      name: command.name,
      status: resolution.status,
    });
  }
  #matches(
    command: PluginToolExecutionCommand,
    value: PluginRetainedToolExecutionResultLookup,
  ) {
    return (
      command.executionId === value.executionId &&
      command.idempotencyKey === value.idempotencyKey &&
      command.actionDigest === value.actionDigest &&
      canonical(command.actionIntent) === canonical(value.actionIntent)
    );
  }
  #limit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error("krea_plugin_scan_limit_invalid");
  }
}
