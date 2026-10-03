import {
  parsePluginUiRecoveryHintsResponse,
  parseStagePluginUiRecoveryResponse,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import { registerPluginUiInvocation } from "./plugin-ui-invocation-authority.ts";
import { uiOutput } from "./plugin-ui-application-support.ts";
import { requirePluginUiRecovery } from "./plugin-ui-recovery-invocation.ts";
import type {
  PluginUiActionContext,
  PluginUiPackageContext,
} from "./plugin-ui-ports.ts";
import type { PluginUiRecoveryPort } from "./plugin-ui-recovery-ports.ts";

/** Only the actual UI application creates these callbacks from its private mount binding. */
export type PluginUiRecoveryOperation = Readonly<{
  context: PluginUiActionContext;
  port: PluginUiRecoveryPort | undefined;
  assertCurrent(): Promise<void>;
  assertActive(): void;
  assertTransactionCurrent(): Promise<void>;
}>;

export function pluginUiRecoveryActionContext(
  binding: Readonly<{
    context: PluginUiPackageContext;
    lease: PluginUiActionContext["lease"];
    authorityEpoch: string;
  }>,
  action: string,
  input: PluginUiActionContext["input"],
): PluginUiActionContext {
  return Object.freeze({
    ...binding.context,
    lease: binding.lease,
    authorityEpoch: binding.authorityEpoch,
    action,
    input,
  });
}

export async function getPluginUiRecovery(
  operation: PluginUiRecoveryOperation,
) {
  await operation.assertCurrent();
  const recovery = requirePluginUiRecovery(
    operation.context.lease,
    operation.port,
  );
  const unregister = registerPluginUiInvocation(
    operation.context,
    operation.assertCurrent,
    operation.assertActive,
  );
  try {
    const output = await recovery.get(operation.context);
    await operation.assertCurrent();
    return uiOutput(() => parsePluginUiRecoveryHintsResponse(output));
  } finally {
    unregister();
  }
}

export async function stagePluginUiRecovery(
  operation: PluginUiRecoveryOperation,
  request: PluginUiRecoveryRequest,
) {
  await operation.assertCurrent();
  const recovery = requirePluginUiRecovery(
    operation.context.lease,
    operation.port,
  );
  const unregister = registerPluginUiInvocation(
    operation.context,
    operation.assertCurrent,
    operation.assertActive,
    { assertCurrent: operation.assertTransactionCurrent },
  );
  try {
    const output = await recovery.stage(operation.context);
    await operation.assertCurrent();
    return uiOutput(() => parseStagePluginUiRecoveryResponse(output, request));
  } finally {
    unregister();
  }
}
