import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { patchPanelState } from "../shared/panelState";
import {
  approvalHandledBody,
  dynamicToolHandledBody,
  externalSecretHandledBody,
  mcpElicitationHandledBody,
  userInputHandledBody,
} from "./serverRequestPresentation";

export function externalSecretHandledPatch(
  wasExplicitReject: boolean,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    actions: undefined,
    fields: undefined,
    body: externalSecretHandledBody(wasExplicitReject, locale),
  };
}

export function externalSecretHandledPanel(
  panel: CapabilityPanel | null,
  wasExplicitReject: boolean,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(
    panel,
    externalSecretHandledPatch(wasExplicitReject, locale),
  );
}

export function mcpElicitationHandledPatch(
  action: "accept" | "decline" | "cancel",
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    actions: undefined,
    fields: undefined,
    body: mcpElicitationHandledBody(action, locale),
  };
}

export function mcpElicitationHandledPanel(
  panel: CapabilityPanel | null,
  action: "accept" | "decline" | "cancel",
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, mcpElicitationHandledPatch(action, locale));
}

export function dynamicToolHandledPatch(
  success: boolean,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    actions: undefined,
    fields: undefined,
    body: dynamicToolHandledBody(success, locale),
  };
}

export function dynamicToolHandledPanel(
  panel: CapabilityPanel | null,
  success: boolean,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, dynamicToolHandledPatch(success, locale));
}

export function userInputHandledPatch(
  shouldSubmit: boolean,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    actions: undefined,
    fields: undefined,
    body: userInputHandledBody(shouldSubmit, locale),
  };
}

export function userInputHandledPanel(
  panel: CapabilityPanel | null,
  shouldSubmit: boolean,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, userInputHandledPatch(shouldSubmit, locale));
}

export function approvalHandledPatch(
  isApprove: boolean,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    actions: undefined,
    body: approvalHandledBody(isApprove, locale),
  };
}

export function approvalHandledPanel(
  panel: CapabilityPanel | null,
  isApprove: boolean,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, approvalHandledPatch(isApprove, locale));
}
