import {
  PluginNodeHost,
  type PluginActivationCandidate,
} from "./plugin-node-host.ts";

/** Read the actual published Node action without supplying an invocation or writable host service. */
export async function verifyInstalledProjectActionDeclaration(
  input: Readonly<{
    installRoot: string;
    pluginId: string;
    packageDigest: string;
    contributionId: string;
    assertCurrent(candidate: PluginActivationCandidate): Promise<void>;
    assertActive(): void;
  }>,
): Promise<void> {
  input.assertActive();
  const host = new PluginNodeHost({ services: [] });
  let preparation: Awaited<ReturnType<PluginNodeHost["prepare"]>> | undefined;
  let candidate: PluginActivationCandidate | null = null;
  try {
    preparation = await host.prepare({
      installRoot: input.installRoot,
      expectedPluginId: input.pluginId,
      expectedPackageDigest: input.packageDigest,
      authorizeActivation: async (actual) => {
        await input.assertCurrent(actual);
        input.assertActive();
        candidate = actual;
        return "allow" as const;
      },
    });
    if (candidate === null) invalid();
    await input.assertCurrent(candidate);
    const identity = preparation.commit({
      authorizeCommit: () => {
        input.assertActive();
        return "allow" as const;
      },
    });
    const lease = host.acquire({
      pluginId: input.pluginId,
      packageDigest: input.packageDigest,
      purpose: "newOperation",
      authorizeBorrow: (actual) => {
        input.assertActive();
        return actual === identity ? "allow" : "deny";
      },
    });
    try {
      const service: unknown = lease.getService(input.pluginId, "1");
      if (
        service === null ||
        typeof service !== "object" ||
        Array.isArray(service)
      )
        invalid();
      const fields = Object.getOwnPropertyDescriptors(service);
      if (
        Reflect.ownKeys(service).length !== 2 ||
        !fields.actions?.enumerable ||
        !Object.hasOwn(fields.actions, "value") ||
        !fields.invoke?.enumerable ||
        !Object.hasOwn(fields.invoke, "value") ||
        typeof fields.invoke.value !== "function"
      )
        invalid();
      const declarations: unknown = fields.actions.value;
      if (
        !Array.isArray(declarations) ||
        Object.getPrototypeOf(declarations) !== Array.prototype ||
        declarations.length > 32 ||
        Reflect.ownKeys(declarations).length !== declarations.length + 1
      )
        invalid();
      let matched = 0;
      for (let index = 0; index < declarations.length; index++) {
        const own = Object.getOwnPropertyDescriptor(
          declarations,
          String(index),
        );
        if (!own?.enumerable || !Object.hasOwn(own, "value")) invalid();
        const declaration: unknown = own.value;
        if (
          declaration === null ||
          typeof declaration !== "object" ||
          Array.isArray(declaration) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(declaration))
        )
          invalid();
        const fields = Object.getOwnPropertyDescriptors(declaration);
        if (
          Reflect.ownKeys(declaration).length !== 3 ||
          ["contributionId", "action", "kind"].some(
            (key) =>
              !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, "value"),
          )
        )
          invalid();
        if (
          fields.contributionId!.value === input.contributionId &&
          fields.action!.value === "project.execute"
        ) {
          if (fields.kind!.value !== "generateTask") invalid();
          matched++;
        }
      }
      if (matched !== 1) invalid();
    } finally {
      lease.release();
    }
    await input.assertCurrent(candidate);
    input.assertActive();
  } catch (error) {
    await preparation?.abort();
    throw error;
  } finally {
    await host.close();
  }
}
function invalid(): never {
  throw new Error("project_conversation_action_unavailable");
}
