import { ApplicationError } from "@crewon/application";
import {
  ContractValidationError,
  type ErrorCategory,
  type ErrorEnvelope,
} from "@crewon/contracts";

import { ControlApiIdentityError } from "./control-api-ports.ts";
import { ProviderProbeWorkerError } from "./provider-probe-worker-client.ts";
import { LocalSettingsRevisionConflictError } from "./local-settings-store.ts";

export class LocalSettingsUnavailableError extends Error {
  readonly code = "local_settings_unavailable";
}

export type ErrorResponse = Readonly<{
  statusCode: number;
  body: ErrorEnvelope;
}>;

export class WorkspaceControlUnavailableError extends Error {
  readonly code = "workspace_command_factory_unavailable";

  constructor() {
    super("workspace_command_factory_unavailable");
    this.name = "WorkspaceControlUnavailableError";
  }
}

export class WorkspaceNativeReadonlyUnavailableError extends Error {
  readonly code = "workspace_native_readonly_unavailable";
  constructor(options?: ErrorOptions) {
    super("workspace_native_readonly_unavailable", options);
    this.name = "WorkspaceNativeReadonlyUnavailableError";
  }
}

export function errorResponse(
  error: unknown,
  requestId: string,
): ErrorResponse {
  if (error instanceof ControlApiIdentityError) {
    return response(
      error.category,
      error.code,
      requestId,
      error.category === "authentication" ? 401 : 403,
    );
  }
  if (error instanceof ContractValidationError) {
    return response("validation", error.code, requestId, 400);
  }
  if (error instanceof LocalSettingsRevisionConflictError) {
    return response("conflict", error.code, requestId, 409);
  }
  if (error instanceof LocalSettingsUnavailableError) {
    return response("deviceUnavailable", error.code, requestId, 503);
  }
  if (error instanceof ProviderProbeWorkerError) {
    if (error.code === "provider_probe_worker_unavailable") {
      return response("providerUnavailable", error.code, requestId, 503);
    }
    return response("internal", "provider_probe_failed", requestId, 500);
  }
  if (error instanceof ApplicationError) {
    if (error.code === "workspace_command_factory_unavailable") {
      return response("deviceUnavailable", error.code, requestId, 503);
    }
    return response(
      error.category,
      error.code,
      requestId,
      applicationStatusCode(error.category),
    );
  }
  if (error instanceof WorkspaceControlUnavailableError) {
    return response(
      "deviceUnavailable",
      "workspace_command_factory_unavailable",
      requestId,
      503,
    );
  }
  if (error instanceof WorkspaceNativeReadonlyUnavailableError) {
    return response("deviceUnavailable", error.code, requestId, 503);
  }
  if (isFastifyBadRequest(error)) {
    return response("validation", "request_body_invalid", requestId, 400);
  }
  return response("internal", "internal_error", requestId, 500);
}

export function notFoundResponse(requestId: string): ErrorResponse {
  return response("notFound", "route_not_found", requestId, 404);
}

export function readinessErrorResponse(requestId: string): ErrorResponse {
  return response("internal", "service_not_ready", requestId, 503);
}

function response(
  category: ErrorCategory,
  code: string,
  requestId: string,
  statusCode: number,
): ErrorResponse {
  return {
    statusCode,
    body: {
      error: {
        category,
        code,
        message: safeMessage(category),
        requestId,
      },
    },
  };
}

function applicationStatusCode(category: ApplicationError["category"]): number {
  switch (category) {
    case "authorization":
      return 403;
    case "notFound":
      return 404;
    case "conflict":
      return 409;
    case "validation":
      return 400;
    case "internal":
      return 500;
  }
}

function safeMessage(category: ErrorCategory): string {
  switch (category) {
    case "authentication":
      return "Authentication is required.";
    case "authorization":
      return "This action is not allowed.";
    case "notFound":
      return "The requested resource was not found.";
    case "conflict":
      return "The request conflicts with the current resource state.";
    case "validation":
      return "The request is invalid.";
    case "rateLimit":
      return "Too many requests.";
    case "providerUnavailable":
      return "The model provider is unavailable.";
    case "deviceUnavailable":
      return "The execution device is unavailable.";
    case "unknownOutcome":
      return "The operation outcome is not yet known.";
    case "internal":
      return "The service could not complete the request.";
  }
}

function isFastifyBadRequest(
  error: unknown,
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code.startsWith("FST_ERR_CTP_") ||
      error.code.startsWith("FST_ERR_VALIDATION"))
  );
}
