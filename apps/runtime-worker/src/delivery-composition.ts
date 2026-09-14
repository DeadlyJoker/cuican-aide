import {
  DeliveryApplicationService,
  type DeliveryStorePort,
  type SpreadsheetEnginePort,
} from "@crewon/application";
import {
  loadArtifactEncryptionKey,
  SpreadsheetEngine,
} from "@crewon/artifacts";
import { SqliteDeliveryStore } from "@crewon/store";
import {
  DeliveryError,
  deliveryId,
  XLSX_MEDIA_TYPE,
  type DeliveryInputRecord,
} from "@crewon/domain";
import {
  CompositeToolRuntime,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import { configuredDeliveryToolCatalog } from "./delivery-tool-catalog.ts";
import {
  createDeliveryToolRuntime,
  StoreBackedDeliveryAccess,
  type DeliveryRuntimeAuthorityStore,
} from "./delivery-tool-runtime.ts";

export type RuntimeDeliveryConfig = Readonly<{
  store: DeliveryStorePort;
  engine: SpreadsheetEnginePort;
}>;

export type DeliveryDownloadImporter = (
  input: Readonly<{
    runId: string;
    executionId: string;
    name: string;
    mediaType: string;
    content: Uint8Array;
  }>,
) => Promise<DeliveryInputRecord>;

/** Receives actual downloaded bytes; the browser cannot supply a Thread, actor, or host path. */
export function createDeliveryDownloadImporter(
  application: Pick<DeliveryApplicationService, "importFromRun">,
  access: StoreBackedDeliveryAccess,
): DeliveryDownloadImporter {
  return async (input) => {
    const executionId = deliveryId(input.executionId);
    const { actor, threadId } = await access.resolve(deliveryId(input.runId));
    if (input.mediaType !== "text/csv" && input.mediaType !== XLSX_MEDIA_TYPE)
      throw new DeliveryError("delivery_input_type_invalid");
    return application.importFromRun(
      actor,
      threadId,
      {
        name: input.name,
        role: "data",
        mediaType: input.mediaType,
        content: input.content,
      },
      { key: `browser-download:${executionId}`, sourceRunId: input.runId },
    );
  };
}

export function createConfiguredRuntimeDelivery(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeDeliveryConfig | undefined {
  if (configuredDeliveryToolCatalog(environment) === "disabled")
    return undefined;
  return {
    store: new SqliteDeliveryStore({
      databasePath: `${environment.CREWON_ARTIFACT_DB_PATH!.trim()}.delivery.sqlite`,
      encryptionKey: loadArtifactEncryptionKey(
        environment.CREWON_ARTIFACT_ENCRYPTION_KEY_PATH!.trim(),
      ),
    }),
    engine: new SpreadsheetEngine(),
  };
}

export function withDeliveryToolRuntime(input: {
  runtime: ToolRuntimePort;
  catalog: "enabled" | "disabled" | undefined;
  delivery: RuntimeDeliveryConfig | undefined;
  store: DeliveryRuntimeAuthorityStore;
  tenantId: string;
  configureDownloads?: (importer: DeliveryDownloadImporter) => void;
}): ToolRuntimePort {
  if ((input.catalog === "enabled") !== (input.delivery !== undefined))
    throw new Error("runtime_delivery_configuration_incomplete");
  if (input.delivery === undefined) return input.runtime;
  const access = new StoreBackedDeliveryAccess(input.store, input.tenantId);
  const application = new DeliveryApplicationService({
    ...input.delivery,
    access,
  });
  input.configureDownloads?.(
    createDeliveryDownloadImporter(application, access),
  );
  return new CompositeToolRuntime([
    input.runtime,
    createDeliveryToolRuntime({ application, access }),
  ]);
}
