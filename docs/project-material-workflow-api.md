# Workflow API reference-material transfers

Reference preparation uses the service protocol saved on the target configuration. It does not infer a protocol from a hostname, rewrite an existing preparation, or treat a returned filename as a byte proof.

- Historical native transfers keep `comfyui-image-upload.v1`, preparation schemas v1/v2, `POST /upload/image`, the original multipart body and request digest, and the output namespace. Recovery reconstructs their recorded adapter, even if a newer default configuration exists.
- Newly reserved `workflow-panel-v1` and `workflow-api-v1` transfers use `comfyui-workflow-file-upload.v1` and preparation schema v3. They send one PNG through `POST /api/comfy/upload/file`, with a unique preparation-and-content filename, `overwrite=false`, and the `file` field. The provider stores it in the input namespace. Readback uses the exact `GET /api/comfy/view` address and verifies PNG dimensions, length and digest against the encrypted source archive.
- A durable dispatch claim precedes upload. A lost response stays unknown; cold observation checks the original address and never uploads again. A renamed file, wrong namespace or mismatched byte observation cannot qualify a material.
- The Main-owned preview offers the exact protocol-specific upload route as separate consent. Metadata preparation and ordinary image generation do not grant uploads. The renderer displays the route from this immutable preview; confirmation still references only its Main-owned preview ID.
- Native source archival separately checks the original source configuration, tenant, space, version, configuration digest, package digest, origin and exact GET grant. Source output files remain output-only. The input/output union is limited to prepared target files; generated-result validation is unchanged.
- Reference workflows submit their immutable reviewed local graph through the panel's `source=quick` route. They do not resolve a remotely mutable saved workflow ID. Worker independently reconstructs the same graph and protocol-specific request before allowing dispatch.

## Compatibility and verification

No SQL schema migration is needed: v3 is a new immutable record discriminator. Updated readers accept native v1/v2 and workflow v3. Older readers reject v3 rather than reinterpret it as a native upload. Preserve data backups when rolling back to an older binary; do not delete or rewrite v3 rows to make it start.

The desktop IPC preview keeps its version and gains one explicitly enumerated upload route; an older strict renderer rejects an unknown route. Host and renderer must therefore ship together. Historical native request rendering remains byte-for-byte stable.

Result declarations may include `publishPublications`, an explicit nonempty subset of their readable publications. This allows a newly consented package to publish without upgrading historical read-only packages. Omitting the subset preserves the previous all-publications meaning; each publisher still requires an exact generation declaration. Native output approval enforces this subset before egress or archival and checks the exact approved native or Workflow API view route. Older strict parsers reject the new field, so Main and Control must be upgraded together; restoring an older binary requires its matching approval backup.

Tests cover real SQLite claims, encrypted archive reads, lost acknowledgements, cold recovery without another upload, exact readback identities, native request compatibility, Main preview/confirmation separation, rendered consent text, pinned HTTP route and body bounds, and the packaged Tool runtime. PostgreSQL cases require the configured test database. Real provider uploads, reference adoption/reopen, AI visual/audio review and the final film remain separate client acceptance requirements.
