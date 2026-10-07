/** Independent media generation protocol; generic invoke works with the existing SDK. */
export const MEDIA_GENERATE = "crewon.project-media-generations.v1.generate";
export const MEDIA_RECOVERY = "crewon.project-media-generations.v2.getRecovery";
export type MediaGenerationRequest = Readonly<{
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  expectedInputRevision: number;
  executionId: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
}>;
export type MediaGenerationReceipt = Readonly<{
  disposition: "committed" | "replayed";
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  executionId: string;
  threadId: string;
  threadRevision: number;
  runId: string;
}>;
export type MediaGenerationRecovery = Readonly<{
  sourcePin: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    selectionRevision: number;
    contributionId: string;
  }>;
  request: Readonly<{
    action: typeof MEDIA_GENERATE;
    input: MediaGenerationRequest;
  }>;
  revision: number;
  phase: "prepared" | "dispatched" | "accepted" | "refused";
  dispatchMayHaveOccurred: boolean;
  dispatchAttemptCount: number;
  retryable: boolean;
  reasonCode: string | null;
  receipt: MediaGenerationReceipt | null;
}>;
export type MediaGenerationCodec = Readonly<{
  parseGenerateProjectMediaRequest(input: unknown): MediaGenerationRequest;
  parseGenerateProjectMediaResponse(
    request: MediaGenerationRequest,
    input: unknown,
  ): MediaGenerationReceipt;
  parseProjectMediaGenerationRecoveryResponse(
    input: unknown,
  ): Readonly<{ intent: MediaGenerationRecovery | null }>;
}>;
export type MediaGenerationClient = Readonly<{
  generate(
    input: MediaGenerationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<MediaGenerationReceipt>;
  recover(options?: {
    signal?: AbortSignal;
  }): Promise<Readonly<{ intent: MediaGenerationRecovery | null }>>;
}>;
export function createMediaGenerationClient(
  services: {
    invoke(
      action: string,
      input: Readonly<Record<string, string | number>> | null,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  },
  codec: MediaGenerationCodec,
): MediaGenerationClient {
  const invoke = services.invoke.bind(services);
  return Object.freeze({
    async generate(
      input: MediaGenerationRequest,
      options: { signal?: AbortSignal } = {},
    ) {
      const request = codec.parseGenerateProjectMediaRequest(input);
      options.signal?.throwIfAborted();
      return codec.parseGenerateProjectMediaResponse(
        request,
        await invoke(MEDIA_GENERATE, request, options),
      );
    },
    async recover(options: { signal?: AbortSignal } = {}) {
      options.signal?.throwIfAborted();
      const response = codec.parseProjectMediaGenerationRecoveryResponse(
        await invoke(MEDIA_RECOVERY, null, options),
      );
      options.signal?.throwIfAborted();
      return response;
    },
  });
}
