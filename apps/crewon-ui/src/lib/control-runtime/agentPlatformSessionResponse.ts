import {
  assertAgentPlatformSessionCurrent,
  type AgentPlatformSessionSnapshot,
} from "../agent-platform/agentPlatformClient";

/** Keep every body reader on the account that authorized the HTTP request. */
export class AgentPlatformSessionResponse extends Response {
  readonly #session: AgentPlatformSessionSnapshot;
  readonly #metadata: Readonly<{
    url: string;
    type: ResponseType;
    redirected: boolean;
  }>;

  constructor({
    response,
    session,
    metadata,
  }: {
    response: Response;
    session: AgentPlatformSessionSnapshot;
    metadata?: Readonly<{
      url: string;
      type: ResponseType;
      redirected: boolean;
    }>;
  }) {
    super(sessionBody(response.body, session), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
    this.#session = session;
    this.#metadata = metadata ?? {
      url: response.url,
      type: response.type,
      redirected: response.redirected,
    };
  }

  override get url(): string {
    return this.#metadata.url;
  }
  override get type(): ResponseType {
    return this.#metadata.type;
  }
  override get redirected(): boolean {
    return this.#metadata.redirected;
  }

  async #read<T>(read: () => Promise<T>): Promise<T> {
    assertAgentPlatformSessionCurrent(this.#session);
    try {
      const result = await read();
      assertAgentPlatformSessionCurrent(this.#session);
      return result;
    } catch (error) {
      assertAgentPlatformSessionCurrent(this.#session);
      throw error;
    }
  }

  override json(): Promise<unknown> {
    return this.#read(() => super.json());
  }
  override text(): Promise<string> {
    return this.#read(() => super.text());
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.#read(() => super.arrayBuffer());
  }
  override blob(): Promise<Blob> {
    return this.#read(() => super.blob());
  }
  override formData(): Promise<FormData> {
    return this.#read(() => super.formData());
  }
  override clone(): Response {
    assertAgentPlatformSessionCurrent(this.#session);
    return new AgentPlatformSessionResponse({
      response: super.clone(),
      session: this.#session,
      metadata: this.#metadata,
    });
  }
}

function sessionBody(
  body: ReadableStream<Uint8Array> | null,
  session: AgentPlatformSessionSnapshot,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          assertAgentPlatformSessionCurrent(session);
          reader ??= body.getReader();
          const chunk = await reader.read();
          assertAgentPlatformSessionCurrent(session);
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          void (reader ? reader.cancel(error) : body.cancel(error)).catch(
            () => {},
          );
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader ? reader.cancel(reason) : body.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
