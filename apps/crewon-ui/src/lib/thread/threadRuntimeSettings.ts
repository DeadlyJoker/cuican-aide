import type { AskForApproval } from "@crewon-protocol/v2/AskForApproval";
import type { Model } from "@crewon-protocol/v2/Model";
import type { SandboxMode } from "@crewon-protocol/v2/SandboxMode";

export type CommandComposerPermission =
  | "approve-for-me"
  | "full-access"
  | "request-approval";

export type CommandModelOption = {
  detail?: string;
  isDefault?: boolean;
  label: string;
  value: string;
};

export type ThreadRuntimeSettings = {
  approvalPolicy?: AskForApproval | null;
  model?: string | null;
  sandboxMode?: SandboxMode | null;
};

export const fallbackCommandModelOptions: CommandModelOption[] = [
  { label: "gpt-5.6-sol", value: "gpt-5.6-sol" },
  { label: "gpt-5.6", value: "gpt-5.6" },
  { label: "gpt-5.5", value: "gpt-5.5" },
  { label: "gpt-5-codex", value: "gpt-5-codex" },
  { label: "gpt-5", value: "gpt-5" },
];

export function commandModelOptionsFromModels(
  models: Model[],
): CommandModelOption[] {
  const seen = new Set<string>();
  return models
    .filter((model) => !model.hidden && model.model)
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .flatMap((model) => {
      if (seen.has(model.model)) {
        return [];
      }
      seen.add(model.model);
      return [
        {
          detail:
            model.displayName && model.displayName !== model.model
              ? model.displayName
              : undefined,
          isDefault: model.isDefault,
          label: model.model,
          value: model.model,
        },
      ];
    });
}

export function mergeCommandModelOptions(
  backendOptions: CommandModelOption[],
  additionalOptions: CommandModelOption[] = fallbackCommandModelOptions,
): CommandModelOption[] {
  const seen = new Set<string>();
  return [...backendOptions, ...additionalOptions].filter((option) => {
    if (!option.value || seen.has(option.value)) {
      return false;
    }
    seen.add(option.value);
    return true;
  });
}

export function commandPermissionRuntimeSettings(
  permission: CommandComposerPermission,
): Pick<ThreadRuntimeSettings, "approvalPolicy" | "sandboxMode"> {
  switch (permission) {
    case "approve-for-me":
      return { approvalPolicy: "on-failure", sandboxMode: "workspace-write" };
    case "request-approval":
      return { approvalPolicy: "on-request", sandboxMode: "workspace-write" };
    case "full-access":
      return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
  }
}

export function commandComposerRuntimeSettings({
  model,
  permission,
}: {
  model: string;
  permission: CommandComposerPermission;
}): ThreadRuntimeSettings {
  return {
    model,
    ...commandPermissionRuntimeSettings(permission),
  };
}
