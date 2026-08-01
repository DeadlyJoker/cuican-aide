use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tempfile::NamedTempFile;
use tokio::time::sleep;
use tokio::time::timeout;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Request;
use wiremock::Respond;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::matchers::path_regex;

use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::ProviderIdentityBindingStatus;
use crewon_state::StateRuntime;

#[path = "cloud_agent_vertical_identity.rs"]
mod identity;

pub(super) const AGENT_ID: &str = "agent-demo";
pub(super) const AGENT_REVISION: &str = "agent-version:7";
pub(super) const OUTPUT_TEXT: &str = "Hermetic Cloud Agent result.";
pub(super) const PROVIDER_ID: &str = "agent-platform";
pub(super) const SOURCE_BINDING_ID: &str = "019f6f00-0000-7000-8000-000000000001";

const AGENT_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ATTEMPT_ID: &str = "attempt-w3-01-001";
const OUTPUT_ARTIFACT_ID: &str = "artifact-result-w3-01";
const PROVIDER_RUN_ID: &str = "provider-run-w3-01";
const REVOCATION_STREAM_ID: &str = "019f6f00-0000-7000-8000-000000000010";
const TENANT_ID: &str = "7";
const SPACE_ID: &str = "11";
const SUBJECT: &str = "user:42";

pub(super) struct HermeticCloudServices {
    server: MockServer,
    state: Arc<Mutex<FakeProviderState>>,
    private_key: NamedTempFile,
    trusted_keys: NamedTempFile,
    now: i64,
}

impl HermeticCloudServices {
    pub(super) async fn start(now: i64) -> Result<Self> {
        let private_key = identity::private_key_file()?;
        let trusted_keys = identity::trusted_key_file()?;
        let server = MockServer::start().await;
        let state = Arc::new(Mutex::new(FakeProviderState::new(now)));
        mount_identity_source(&server, identity::snapshot(now)).await;
        mount_provider(&server, Arc::clone(&state)).await;
        Ok(Self {
            server,
            state,
            private_key,
            trusted_keys,
            now,
        })
    }

    pub(super) fn environment(&self) -> Vec<(String, String)> {
        let identity_url = format!("{}/identity/v1/", self.server.uri());
        let provider_url = format!("{}/provider/v3/", self.server.uri());
        let private_key = self.private_key.path().display().to_string();
        let trusted_keys = self.trusted_keys.path().display().to_string();
        vec![
            (
                "CREWON_PRINCIPAL_SESSION_ENABLED".to_string(),
                "true".to_string(),
            ),
            ("CREWON_IDENTITY_SOURCE_URL".to_string(), identity_url),
            (
                "CREWON_IDENTITY_SOURCE_ENDPOINT_MODE".to_string(),
                "development-loopback".to_string(),
            ),
            (
                "CREWON_IDENTITY_SOURCE_SERVICE_SIGNING_KEY_ID".to_string(),
                identity::KEY_ID.to_string(),
            ),
            (
                "CREWON_IDENTITY_SOURCE_SERVICE_SIGNING_PRIVATE_KEY_FILE".to_string(),
                private_key.clone(),
            ),
            (
                "CREWON_IDENTITY_SOURCE_BOOTSTRAP_TRUSTED_PUBLIC_KEYS_FILE".to_string(),
                trusted_keys.clone(),
            ),
            (
                "CREWON_PRINCIPAL_SESSION_TRUSTED_PUBLIC_KEYS_FILE".to_string(),
                trusted_keys,
            ),
            (
                "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED".to_string(),
                "true".to_string(),
            ),
            (
                "CREWON_PROVIDER_AGENT_PLATFORM_URL".to_string(),
                provider_url,
            ),
            (
                "CREWON_PROVIDER_AGENT_PLATFORM_ENDPOINT_MODE".to_string(),
                "development-loopback".to_string(),
            ),
            (
                "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_KEY_ID".to_string(),
                identity::KEY_ID.to_string(),
            ),
            (
                "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_PRIVATE_KEY_FILE".to_string(),
                private_key,
            ),
            (
                "CREWON_PROVIDER_CONTROL_ENABLED".to_string(),
                "true".to_string(),
            ),
            (
                "CREWON_DURABLE_CLOUD_AGENT_ENABLED".to_string(),
                "true".to_string(),
            ),
        ]
    }

    pub(super) fn principal_session_token(&self) -> Result<String> {
        identity::principal_session_token(self.now, self.private_key.path())
    }

    pub(super) async fn seed_authority(&self, home: &Path) -> Result<()> {
        let state = StateRuntime::init(home.to_path_buf(), "w3-01-hermetic-seed".to_string())
            .await
            .context("initialize hermetic State")?;
        let actor_id = identity::stable_actor_id();
        let mut binding = ProviderIdentityBindingRecord {
            binding_id: SOURCE_BINDING_ID.to_string(),
            local_actor_id: actor_id.clone(),
            local_tenant_id: TENANT_ID.to_string(),
            local_space_id: SPACE_ID.to_string(),
            provider_id: PROVIDER_ID.to_string(),
            provider_subject: SUBJECT.to_string(),
            provider_tenant_id: TENANT_ID.to_string(),
            provider_space_id: SPACE_ID.to_string(),
            authority_id: "agent-platform-identity".to_string(),
            source_binding_id: SOURCE_BINDING_ID.to_string(),
            source_revision: 1,
            source_fresh_until: self.now + 59,
            revision: 1,
            status: ProviderIdentityBindingStatus::Active,
            record_hash: String::new(),
            created_at: self.now - 10,
            updated_at: self.now - 10,
        };
        binding.record_hash = binding.canonical_hash();
        match state
            .create_provider_identity_binding_record(&binding)
            .await
            .context("persist identity binding")?
        {
            ProviderIdentityBindingCreateOutcome::Created
            | ProviderIdentityBindingCreateOutcome::ExistingSame => {}
            ProviderIdentityBindingCreateOutcome::Conflict => {
                bail!("hermetic identity binding conflicted")
            }
        }

        let mut grant = ProviderAccessGrantRecord {
            grant_id: "provider-grant:019f6f00-0000-7000-8000-000000000020".to_string(),
            local_actor_id: actor_id,
            local_tenant_id: TENANT_ID.to_string(),
            local_space_id: SPACE_ID.to_string(),
            provider_id: PROVIDER_ID.to_string(),
            source_binding_id: SOURCE_BINDING_ID.to_string(),
            source_revision: 1,
            granted_scopes: identity::provider_scopes(),
            status: ProviderAccessGrantStatus::Active,
            expires_at: self.now + 3_000,
            revision: 1,
            record_hash: String::new(),
            created_at: self.now,
            updated_at: self.now,
            revoked_at: None,
        };
        grant.record_hash = grant.canonical_hash();
        match state
            .resolve_provider_access_grant_record(&grant)
            .await
            .context("persist access grant")?
        {
            ProviderAccessGrantResolveOutcome::Created(_)
            | ProviderAccessGrantResolveOutcome::Existing(_) => {}
            ProviderAccessGrantResolveOutcome::Conflict
            | ProviderAccessGrantResolveOutcome::CapacityExceeded => {
                bail!("hermetic access grant was not persisted")
            }
        }
        state.close().await;
        Ok(())
    }

    pub(super) async fn wait_for_progress(&self) -> Result<()> {
        if let Err(error) = wait_for_state(
            &self.state,
            |state| state.progress_delivered,
            "Provider progress",
        )
        .await
        {
            let paths = self
                .server
                .received_requests()
                .await
                .context("read fake Provider diagnostic paths")?
                .iter()
                .map(|request| request.url.path().to_string())
                .collect::<Vec<_>>();
            bail!("{error}; observed request paths: {paths:?}");
        }
        Ok(())
    }

    pub(super) fn restart_provider_before_completion(&self) {
        let mut state = lock_provider_state(&self.state);
        state.provider_generation += 1;
        state.unavailable_descriptor_responses = 1;
        state.completion_enabled = true;
    }

    pub(super) async fn wait_for_restart_recovery(&self) -> Result<()> {
        wait_for_state(
            &self.state,
            |state| state.unavailable_responses_observed > 0,
            "Provider restart outage",
        )
        .await
    }

    pub(super) async fn wait_for_cancel_request(&self) -> Result<()> {
        wait_for_state(
            &self.state,
            |state| state.cancel_requested,
            "Provider cancellation",
        )
        .await
    }

    pub(super) async fn received_requests(&self) -> Result<Vec<Request>> {
        self.server
            .received_requests()
            .await
            .context("read fake Provider requests")
    }
}

struct FakeProviderState {
    now: i64,
    task_id: Option<String>,
    progress_delivered: bool,
    completion_enabled: bool,
    provider_generation: u64,
    unavailable_descriptor_responses: u32,
    unavailable_responses_observed: u32,
    cancel_requested: bool,
}

impl FakeProviderState {
    fn new(now: i64) -> Self {
        Self {
            now,
            task_id: None,
            progress_delivered: false,
            completion_enabled: false,
            provider_generation: 1,
            unavailable_descriptor_responses: 0,
            unavailable_responses_observed: 0,
            cancel_requested: false,
        }
    }
}

async fn mount_identity_source(server: &MockServer, snapshot: Value) {
    Mock::given(method("POST"))
        .and(path("/identity/v1/principal-revocations:snapshot"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "streamId": REVOCATION_STREAM_ID,
            "watermarkSequence": 0,
            "data": [],
            "nextAfterSequence": null
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/principal-revocations:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [],
            "cursor": {"streamId": REVOCATION_STREAM_ID, "sequence": 0}
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/identity-bindings:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(snapshot))
        .mount(server)
        .await;
}

async fn mount_provider(server: &MockServer, state: Arc<Mutex<FakeProviderState>>) {
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(DescriptorResponder {
            state: Arc::clone(&state),
        })
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:list"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{
                "resource": agent_resource(),
                "manifestSchemaVersion": "1.0.0",
                "contentDigest": AGENT_DIGEST
            }],
            "nextCursor": null
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(agent_manifest()))
        .mount(server)
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/provider/v3/artifacts/[^/]+/revisions/1"))
        .respond_with(ImportArtifactResponder)
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:start"))
        .respond_with(StartRunResponder {
            state: Arc::clone(&state),
        })
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:read"))
        .respond_with(ReadRunResponder {
            state: Arc::clone(&state),
        })
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:listEvents"))
        .respond_with(ListEventsResponder {
            state: Arc::clone(&state),
        })
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:cancel"))
        .respond_with(CancelRunResponder {
            state: Arc::clone(&state),
        })
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/artifacts:read"))
        .respond_with(OutputArtifactResponder)
        .mount(server)
        .await;
}

struct DescriptorResponder {
    state: Arc<Mutex<FakeProviderState>>,
}

impl Respond for DescriptorResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let mut state = lock_provider_state(&self.state);
        if state.unavailable_descriptor_responses > 0 {
            state.unavailable_descriptor_responses -= 1;
            state.unavailable_responses_observed += 1;
            return provider_unavailable();
        }
        ResponseTemplate::new(200).set_body_json(provider_descriptor())
    }
}

struct StartRunResponder {
    state: Arc<Mutex<FakeProviderState>>,
}

impl Respond for StartRunResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        if serde_json::from_slice::<Value>(&request.body).is_err() {
            return invalid_provider_response();
        }
        let Some(task_id) = task_id_from_delegation(request) else {
            return invalid_provider_response();
        };
        lock_provider_state(&self.state).task_id = Some(task_id);
        ResponseTemplate::new(200).set_body_json(json!({
            "providerRunId": PROVIDER_RUN_ID,
            "attemptId": ATTEMPT_ID,
            "created": true
        }))
    }
}

struct ReadRunResponder {
    state: Arc<Mutex<FakeProviderState>>,
}

impl Respond for ReadRunResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let state = lock_provider_state(&self.state);
        ResponseTemplate::new(200).set_body_json(json!({
            "providerRunId": PROVIDER_RUN_ID,
            "attemptId": ATTEMPT_ID,
            "status": if state.completion_enabled { "succeeded" } else { "running" },
            "revision": if state.completion_enabled { 3 } else { 2 },
            "lastSequence": if state.completion_enabled { 3 } else { 2 },
            "createdAt": state.now,
            "updatedAt": state.now + 2
        }))
    }
}

struct ListEventsResponder {
    state: Arc<Mutex<FakeProviderState>>,
}

impl Respond for ListEventsResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = match serde_json::from_slice(&request.body) {
            Ok(body) => body,
            Err(_) => return invalid_provider_response(),
        };
        let after = body.get("afterCursor").and_then(Value::as_str);
        let mut state = lock_provider_state(&self.state);
        match after {
            None => {
                state.progress_delivered = true;
                ResponseTemplate::new(200).set_body_json(json!({
                    "events": [
                        event(/*sequence*/ 1, "event-0001", "runStarted", json!({"revision": 1}), state.now),
                        event(/*sequence*/ 2, "event-0002", "progress", json!({"summary": "working"}), state.now + 1)
                    ],
                    "lastCursor": "event-0002"
                }))
            }
            Some("event-0002") if state.completion_enabled => {
                let Some(task_id) = state.task_id.as_deref() else {
                    return invalid_provider_response();
                };
                ResponseTemplate::new(200).set_body_json(json!({
                    "events": [event(
                        /*sequence*/ 3,
                        "event-0003",
                        "completed",
                        json!({
                            "outputArtifacts": [{
                                "artifactId": OUTPUT_ARTIFACT_ID,
                                "taskId": task_id,
                                "kind": "report",
                                "revision": 1,
                                "retention": "task",
                                "createdAt": state.now + 2
                            }]
                        }),
                        state.now + 2
                    )],
                    "lastCursor": "event-0003"
                }))
            }
            Some("event-0002") => ResponseTemplate::new(200).set_body_json(json!({
                "events": [],
                "lastCursor": "event-0002"
            })),
            Some("event-0003") => ResponseTemplate::new(200).set_body_json(json!({
                "events": [],
                "lastCursor": "event-0003"
            })),
            Some(_) => invalid_provider_response(),
        }
    }
}

struct ImportArtifactResponder;

struct CancelRunResponder {
    state: Arc<Mutex<FakeProviderState>>,
}

impl Respond for CancelRunResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = match serde_json::from_slice(&request.body) {
            Ok(body) => body,
            Err(_) => return invalid_provider_response(),
        };
        if body.get("providerRunId").and_then(Value::as_str) != Some(PROVIDER_RUN_ID)
            || body.get("expectedRevision").and_then(Value::as_u64) != Some(2)
        {
            return invalid_provider_response();
        }
        lock_provider_state(&self.state).cancel_requested = true;
        ResponseTemplate::new(200).set_body_json(json!({
            "status": "cancelRequested",
            "revision": 3,
            "duplicate": false
        }))
    }
}

impl Respond for ImportArtifactResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let segments = request
            .url
            .path()
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        let Some(encoded_artifact_id) = segments.iter().rev().nth(2) else {
            return invalid_provider_response();
        };
        let Some(artifact_id) = percent_decode(encoded_artifact_id) else {
            return invalid_provider_response();
        };
        let Some(task_id) = header(request, "x-crewon-artifact-task-id") else {
            return invalid_provider_response();
        };
        let Some(kind) = header(request, "x-crewon-artifact-kind") else {
            return invalid_provider_response();
        };
        let Some(retention) = header(request, "x-crewon-artifact-retention") else {
            return invalid_provider_response();
        };
        let Some(created_at) = header(request, "x-crewon-artifact-created-at") else {
            return invalid_provider_response();
        };
        let Some(sensitivity) = header(request, "x-crewon-artifact-sensitivity") else {
            return invalid_provider_response();
        };
        let Some(content_digest) = header(request, "x-crewon-content-digest") else {
            return invalid_provider_response();
        };
        let media_type = header(request, "content-type").unwrap_or("text/plain");
        ResponseTemplate::new(200).set_body_json(json!({
            "artifact": {
                "artifactId": artifact_id,
                "taskId": task_id,
                "kind": kind,
                "revision": 1,
                "retention": retention,
                "createdAt": created_at.parse::<i64>().unwrap_or_default()
            },
            "mediaType": media_type,
            "sensitivity": sensitivity,
            "contentDigest": content_digest,
            "byteLength": request.body.len(),
            "created": true
        }))
    }
}

struct OutputArtifactResponder;

impl Respond for OutputArtifactResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = match serde_json::from_slice(&request.body) {
            Ok(body) => body,
            Err(_) => return invalid_provider_response(),
        };
        let artifact_id = body
            .get("artifactId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let revision = body
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if artifact_id != OUTPUT_ARTIFACT_ID || revision != 1 {
            return invalid_provider_response();
        }
        ResponseTemplate::new(200)
            .insert_header("content-type", "text/plain; charset=utf-8")
            .insert_header("x-crewon-artifact-id", OUTPUT_ARTIFACT_ID)
            .insert_header("x-crewon-artifact-revision", "1")
            .insert_header("x-crewon-artifact-sensitivity", "workspaceSensitive")
            .insert_header("x-crewon-content-digest", digest(OUTPUT_TEXT.as_bytes()))
            .set_body_bytes(OUTPUT_TEXT.as_bytes())
    }
}

fn event(sequence: u64, cursor: &str, event_type: &str, payload: Value, created_at: i64) -> Value {
    json!({
        "eventId": format!("event-w3-01-{sequence}"),
        "providerRunId": PROVIDER_RUN_ID,
        "attemptId": ATTEMPT_ID,
        "sequence": sequence,
        "cursor": cursor,
        "schemaVersion": "3.0.0",
        "type": event_type,
        "payload": payload,
        "createdAt": created_at
    })
}

fn provider_descriptor() -> Value {
    json!({
        "providerId": PROVIDER_ID,
        "protocolVersion": "3.0.0",
        "capabilities": ["durableRun", "remoteAgent", "resumableEvents"],
        "resourceCapabilities": [{
            "resourceType": "agent",
            "bindingMode": "providerManaged",
            "executionLocation": "provider"
        }]
    })
}

fn agent_resource() -> Value {
    json!({
        "providerId": PROVIDER_ID,
        "resourceType": "agent",
        "resourceId": AGENT_ID,
        "revision": AGENT_REVISION
    })
}

fn agent_manifest() -> Value {
    json!({
        "resource": agent_resource(),
        "manifestSchemaVersion": "1.0.0",
        "contentDigest": AGENT_DIGEST
    })
}

fn provider_unavailable() -> ResponseTemplate {
    ResponseTemplate::new(503).set_body_json(json!({
        "code": "providerUnavailable",
        "retryable": true,
        "providerRunId": PROVIDER_RUN_ID,
        "traceId": "trace-w3-01-restart"
    }))
}

fn invalid_provider_response() -> ResponseTemplate {
    ResponseTemplate::new(500).set_body_json(json!({
        "code": "invalidRequest",
        "retryable": false,
        "providerRunId": PROVIDER_RUN_ID,
        "traceId": "trace-w3-01-invalid"
    }))
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request.headers.get(name)?.to_str().ok()
}

fn task_id_from_delegation(request: &Request) -> Option<String> {
    let payload = header(request, "x-crewon-delegation")?.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    claims.get("taskId")?.as_str().map(str::to_string)
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        decoded.push(hex(high)?.checked_mul(16)?.checked_add(hex(low)?)?);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

async fn wait_for_state(
    state: &Arc<Mutex<FakeProviderState>>,
    predicate: impl Fn(&FakeProviderState) -> bool,
    description: &str,
) -> Result<()> {
    timeout(Duration::from_secs(15), async {
        loop {
            if predicate(&lock_provider_state(state)) {
                return;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .with_context(|| format!("timed out waiting for {description}"))?;
    Ok(())
}

fn lock_provider_state(state: &Mutex<FakeProviderState>) -> MutexGuard<'_, FakeProviderState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
