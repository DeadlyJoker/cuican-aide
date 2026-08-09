# CrewON Responses transports

`@crewon/agent-responses` is the default SDK-free model transport for the CrewON-owned Agent Kernel. It calls an explicit
Responses-compatible HTTP/SSE endpoint with platform `fetch`, or an explicitly enabled Responses WebSocket endpoint through the
MIT `ws` package. Both paths parse the same bounded protocol decoder and emit only the Kernel's owned `ModelTransportEvent`
union. The Adapter does not own Run, Thread, Message, durable retry, checkpoint or approval state.

The request supports exactly one context strategy:

- `manual`: send the complete bounded message history and omit `previous_response_id`.
- `providerCheckpoint`: accept one bounded, versioned, SDK-free opaque checkpoint. Every request retains the complete canonical
  history plus `newHistoryStartIndex`, so fallback can rebuild safely; the wire request validates adapter/model identity, sends
  only items after the durable boundary, and maps the payload to `previous_response_id`.

Provider storage is false by default. API credentials are optional so an explicitly configured self-hosted endpoint is a
first-class path. There is no dependency on the OpenAI Node SDK or `@openai/agents`.

The optional resilient transport prewarms and reuses one WebSocket connection, keeps connection-local incremental history, and
sends only a verified suffix with `previous_response_id`. A reconnect clears that transient baseline. HTTP 426 switches
immediately; other retryable WebSocket failures get two reconnects, then emit `transport.fallback` and switch to sticky HTTP.
The Kernel turns that into durable `model.transport.fallback`, discards partial output, and resets the HTTP sampling budget.

Bounded HTTP 400 and streamed Provider failures with the exact `context_length_exceeded` code are normalized to
`responses_provider_context_length_exceeded` without exposing Provider response text. The Runtime Worker uses that stable code
for the dedicated Rust-compatible compaction retry path; unrelated invalid requests remain terminal and are never retried as
compaction.

The exact bounded HTTP error code `cyber_policy` is normalized to `responses_provider_cyber_policy` with the `permission`
category. It is non-retryable, its provider message is never copied into the transport error, and Runtime Worker settles the
Run/Attempt/Work Item without committing an assistant Message.

When provider storage is enabled, `response.completed` returns a `crewon.provider-checkpoint.v0` value. The Adapter does not
persist it. Runtime orchestration promotes it together with `segment.checkpointed`, `segment.completed`, the assistant Message and
the terminal Run transaction; a rolled-back response ID cannot become continuation authority.

## Stream and failure contract

- `response.created` must precede text output and terminal events.
- Sequence numbers are strictly monotonic in the default `required` mode. `whenPresent` is an explicit compatibility setting for
  a self-hosted implementation that omits them.
- Text deltas, final output and token usage are validated. Missing usage, duplicate/non-monotonic events, output mismatch,
  oversized frames and unexpected tool events fail closed.
- `response.completed`, `response.failed`, `response.incomplete` and top-level `error` are terminal. EOF or `[DONE]` before a
  terminal event is retryable incomplete transport failure.
- Caller cancellation and idle timeout abort the active HTTP request/body rather than waiting for the next delta.
- WebSocket text frames use the same strict terminal/sequence rules; binary, malformed and oversized frames fail closed. Caller
  cancellation, idle expiry or early consumer termination closes the connection before another request can reuse it.
- Raw provider response bodies and credentials never enter error codes.

The protocol decisions follow the official [Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
and [streaming event reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/content_part).

The local tests start real loopback HTTP and WebSocket servers. They cover fragmented CRLF SSE, handshake headers, startup
prewarm, cross-Turn connection reuse and incremental input, connection-limit reconnect, 426/exhaustion sticky fallback, a fresh
HTTP retry budget, binary rejection, caller abort and deterministic idle expiry. This is compatible-server evidence, not proof
against a live OpenAI account.
