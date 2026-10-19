# Private image inputs for media review

The Agent Kernel accepts captured PNG/JPEG observations through the private
`AgentSegmentRunOptions.imageObservations` option. A dedicated Worker adapter now
uses it to review saved image candidates and persist validated reports through
normal Run completion. It does not register a Native/UI review command, authorize
an artifact read or model transmission, or establish that a video passed review.

## Input and authority

The host must resolve the actual artifact under its existing authorization
before calling `captureModelImageObservation`. Callers cannot supply a URL,
path, file ID, or serialized image capsule. Each capture snapshots the bytes,
hashes that snapshot, and privately binds it to one Run, Segment and AgentVersion.
Cloned or cross-scope capsules fail before dispatch. Capture geometry checks
inspect PNG/JPEG headers; they do not establish full decode integrity, visual
quality, or commercial usage rights.

One request accepts at most six images, 256 KiB per image and 1 MiB in total.
Each image has at most 262,144 pixels and neither edge exceeds 1,024 pixels.
An upstream media reader must decode and prepare bounded review images while
retaining their original artifact/version/timecode provenance. The Worker adapter
prepares saved PNG image candidates. A separate internal video inspector performs
bounded full decode and frame extraction, but video/audio model review and the
production Native admission/recovery integration are not connected.

Image reviews accept message history and no executable tools. Compaction,
durable conversation continuation, and response retrieval with unproven image
context are rejected. Unexpected provider tool calls also fail before a
`tool.requested` event can escape the Kernel.

## Delivery and continuation

Responses HTTP and WebSocket requests project the captured bytes as a user
message containing `input_text` evidence metadata and `input_image` with a data
URL. This matches the [official Responses image-input format](https://developers.openai.com/api/docs/guides/images-vision).
The model must treat text inside images as source material rather than commands.
Existing durable history remains string-based; image bytes never enter canonical
Agent events, persisted history or transport continuation metadata.

An image-bearing request may select only an exact suffix of its original input.
The transport can omit prior images only after it has observed a valid completed
response containing matching evidence in the same Run/Segment/AgentVersion.
Image identity includes evidence ID, byte digest, media type and detail level.
An unknown checkpoint, changed/removed evidence, state release or eviction causes
a full manual request without `previous_response_id`. Invalid received terminal
tails cannot establish this completed lineage.

Lineage contains metadata only and is bounded to 32 Runs with 16 responses each;
Run release clears its entries. WebSocket reuse follows the same rules, and its
HTTP fallback can resend the complete supplied input. Pre-response sampling
retries preserve the same captured bytes. A review interrupted after response
creation cannot use this input option to retrieve an unproven provider response;
business-level recovery must requalify the evidence and its authorization.

## Compatibility and verification

This adds an internal input variant, not a public HTTP or persisted history
shape. Provider output remains `AgentHistoryItem`; the new image type is input
only. Requests without images retain the existing checkpoint, tool, compaction
and retry behavior. No image fetch, generation or upload permission is added.

Tests cover real HTTP with a held-open response body, real WebSocket reuse,
WebSocket-to-HTTP fallback, provider continuation, pre-response retries, stale
checkpoints, image replacement, eviction, private capture and byte budgets,
tool rejection, malformed ordinary history, and unchanged durable text history.
Fixture responses prove wire/protocol behavior only; no real model visual
judgment, audio review, final video or commercial acceptance has passed yet.

## Saved-candidate review adapter

`MediaImageReviewSourceReader` borrows the actual encrypted candidate publisher
and a host-configured `MediaReviewImageEncoder`. Its input contains business
selectors and the exact accepted candidate pin, never a supplier URL. Read
authorization is checked by the publisher. Sending pixels to the model requires
an independent `projectMediaImageReview:send` decision, rechecked after
preparation and before accepting the completed report. Opaque prepared inputs
cannot be reconstructed from their serialized metadata.

The encoder requires an absolute, host-approved FFmpeg executable path. It
does not search PATH, download tools, create files or accept a command/filter
from the model. It checks PNG integrity, then pipes bytes to the explicit PNG
decoder and JPEG encoder. Scaling preserves aspect ratio within 512×512 without
upscaling; transparency is composited over white and this transformation is
recorded in the report. Output is capped at 256 KiB. One conversion per Node
process, single-threaded codec/filter work and a ten-second deadline bound local
resource use. Close/cancellation kills and joins the physical child before
admission is released. Credentials and codec/proxy overrides are not inherited.
The protocol and filter options follow the [FFmpeg protocol documentation](https://ffmpeg.org/ffmpeg-protocols.html#pipe)
and [scale filter documentation](https://ffmpeg.org/ffmpeg-filters.html#scale-1).

`MediaImageReviewKernel` is bound by the trusted host to one accepted review Run,
thread, actor, reviewer version and candidate. It verifies the current running
Run in the original Store, disables Tools, appends a bounded review prompt and
uses normal Worker accounting, streaming and persistence. It validates the
model's complete JSON report against the actual candidate and sent thumbnail,
then rechecks source/send authority before yielding completion. An invalid
report or unavailable source cannot silently trigger another model charge;
only a busy encoder can retry before model dispatch.

The normal Run history persists the actual model report; no parallel database
or synthetic tool receipt is introduced. The Native SQLite host now has an
explicit `MediaImageReviewJobService`: it prepares an authorized ordinary Turn,
qualifies the saved candidate and independent image-send permission, then commits
the original Turn and an immutable job on the original connection. Existing
queues, events, history, usage and idempotency remain the execution path. A final
grant failure rolls back the Run, message, outbox, work item, job and receipt.

The new `project_media_image_review_jobs` schema is an additive, explicit opt-in.
Constructors and ordinary startup do not migrate it. It pins actor/project,
generation/result, candidate/original-byte digests, review Run/thread, host
authority/runtime generation, reviewer version, policy, transformation and
creation time. Recovery checks the original schema integrity, indexed record,
Run identity and current saved-candidate provenance. Missing/damaged jobs fail;
an ordinary Turn receipt or report JSON cannot be promoted into an admission.
The store retains the existing ordinary-thread/project fence, including older
databases without the optional thread-binding column.

`MediaImageReviewKernel.restore` uses only the scoped Run locator and the original
SQLite store to recover this binding. The adapter rechecks it before model
dispatch and before reading a report. A persisted admission never replaces
current source/read/send decisions. Reading a report requires candidate read
permission and sends nothing to a model. Replaying an already accepted request
does not create a new Run, thumbnail or model-send decision, even if its send
permission has since been withdrawn.

This admission adapter is currently Native SQLite only; PostgreSQL admission is
not implemented or silently substituted with an ordinary Turn. The production
Native approval/configuration, Control admission endpoint and workbench entry
are still required before exposing this as a user feature. Completed-report cold
restore is tested; interruption/resume and real-client acceptance remain unproven.

## Reviewer runtime dispatch

The existing `ConfiguredAgentVersionRuntimeFactory` now accepts an explicit
trusted-host `savedImageReview` purpose, borrowing the original SQLite store,
source reader and exact actor. It validates tenant, reviewer version, no workspace,
no Tools, no governed context and no automatic compaction before opening the
transport. Shared tool-runtime projections cannot own this purpose. Ordinary
bindings retain their existing Kernel. No public JSON flag grants image-send
permission or creates this purpose.

`MediaImageReviewRoutingKernel` handles multiple real review Runs with one pinned
reviewer runtime. Each segment restores the original job from SQL, checks the
actor/route and delegates to the protected image review Kernel. It does not cache
serialized reports or create another execution loop. Close aborts and joins
in-flight review work before the runtime owner is released.

Worker runtime resolution performs a read-only Native SQLite review-job check.
An admitted image review cannot be handed to an ordinary text/provider Kernel:
the selected Kernel must be an actual protected review instance tied to the same
original store and Run/actor/route. Invalid dispatch or schema fails permanently
before a model call. This prevents a superficially complete text report without
actual image evidence. The read probe never migrates tables or grants source
read/send access. A configured reviewer also refuses missing admission; it never
falls back to a normal text run.

Controlled tests exercise the actual Factory, runtime registry, Worker, original
SQL admission, encrypted candidate archive, FFmpeg and local HTTP response.
One configured runtime completes two different admitted Runs and cold-reads its
saved report after send permission withdrawal; a normal Kernel dispatch produces
zero model requests. Actual in-flight HTTP cancellation is joined on owner close.
Model semantics and permissions remain named fixtures. The production Native
configuration and live UI have not enabled this internal registration yet.

The report names one image, the original candidate/byte digest, the derived
thumbnail digest/dimensions and its actual reviewer Run. Findings have a visible
region, severity and a repair recommendation. Changed source identity yields
`stale`; no findings yields only `no-issues-in-reviewed-image`. Story, motion,
audio and licensing always remain explicitly unchecked. A single-frame review
cannot approve a whole movie.
