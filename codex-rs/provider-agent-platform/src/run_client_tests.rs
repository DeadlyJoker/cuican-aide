use std::net::IpAddr;
use std::sync::Mutex;

use crewon_provider_transport::EndpointResolver;
use crewon_provider_transport::ProviderEndpointPolicy;
use crewon_provider_transport::ProviderEndpointPolicyError;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use pretty_assertions::assert_eq;
use serde_json::Value;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;
use crate::DelegationToken;
use crate::DiscoveryAuthorizationOperation;
use crate::ProviderArtifactKind;
use crate::ProviderArtifactRef;
use crate::ProviderArtifactRetention;
use crate::ProviderAuthorizationHeaders;
use crate::ProviderAuthorizationRequest;
use crate::ProviderRunAuthorizationBinding;
use crate::ProviderRunCancelStatus;
use crate::ProviderRunEventPayload;
use crate::ProviderRunStatus;
use crate::ServiceBearerToken;

const DISCOVERY_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_discovery.v1.json");

struct FixedResolver(IpAddr);

impl EndpointResolver for FixedResolver {
    async fn resolve(
        &self,
        _host: String,
        _port: u16,
    ) -> Result<Vec<IpAddr>, ProviderEndpointPolicyError> {
        Ok(vec![self.0])
    }
}

#[derive(Default)]
struct RecordingAuthorizer {
    requests: Mutex<Vec<ProviderAuthorizationRequest>>,
}

impl ProviderAuthorizer for RecordingAuthorizer {
    async fn authorize(
        &self,
        request: ProviderAuthorizationRequest,
    ) -> Result<ProviderAuthorizationHeaders, ProviderAuthorizationError> {
        self.requests.lock().expect("requests lock").push(request);
        ProviderAuthorizationHeaders::new(
            ServiceBearerToken::new("service-run-token").expect("service token"),
            DelegationToken::new("delegation-run-token").expect("delegation token"),
        )
    }
}

fn binding() -> ProviderRunAuthorizationBinding {
    ProviderRunAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind: ResourceKind::Agent,
            resource_id: ResourceId::new("agent-demo").expect("resource id"),
            revision: ResourceRevision::new("agent-version:7").expect("revision"),
        },
        "task-demo",
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("binding")
}

async fn connected_client(server: &MockServer) -> AgentPlatformProviderClient<RecordingAuthorizer> {
    let discovery: Value = serde_json::from_str(DISCOVERY_FIXTURE).expect("discovery fixture");
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(discovery["descriptor"].clone()))
        .expect(1)
        .mount(server)
        .await;
    let policy = ProviderEndpointPolicy::development_loopback();
    let endpoint = policy
        .validate(
            &format!("{}/provider/v3/", server.uri()),
            &FixedResolver(server.address().ip()),
        )
        .await
        .expect("endpoint");
    AgentPlatformProviderClient::connect(policy, endpoint, RecordingAuthorizer::default())
        .await
        .expect("connected client")
}

#[tokio::test]
async fn durable_run_client_executes_strict_start_read_events_and_cancel() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:start"))
        .and(body_partial_json(serde_json::json!({
            "type": "start",
            "commandId": "command-start-001",
            "idempotencyKey": "task-demo:start:1",
            "requestDigest": "sha256:request-demo",
            "resource": {
                "providerId": "agent-platform",
                "resourceType": "agent",
                "resourceId": "agent-demo",
                "revision": "agent-version:7"
            }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "providerRunId": "provider-run-demo",
            "attemptId": "attempt-demo-001",
            "created": true
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:read"))
        .and(body_partial_json(serde_json::json!({
            "type": "read",
            "commandId": "command-read-001",
            "providerRunId": "provider-run-demo"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "providerRunId": "provider-run-demo",
            "attemptId": "attempt-demo-001",
            "status": "running",
            "revision": 2,
            "lastSequence": 2,
            "createdAt": 100,
            "updatedAt": 110
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:listEvents"))
        .and(body_partial_json(serde_json::json!({
            "type": "listEvents",
            "commandId": "command-events-001",
            "providerRunId": "provider-run-demo",
            "afterCursor": null,
            "limit": 100
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "events": [
                {
                    "eventId": "event-demo-001",
                    "providerRunId": "provider-run-demo",
                    "attemptId": "attempt-demo-001",
                    "sequence": 1,
                    "cursor": "event-0001",
                    "schemaVersion": "3.0.0",
                    "type": "runStarted",
                    "payload": {"revision": 1},
                    "createdAt": 100
                },
                {
                    "eventId": "event-demo-002",
                    "providerRunId": "provider-run-demo",
                    "attemptId": "attempt-demo-001",
                    "sequence": 2,
                    "cursor": "event-0002",
                    "schemaVersion": "3.0.0",
                    "type": "progress",
                    "payload": {"summary": "working"},
                    "createdAt": 110
                }
            ],
            "lastCursor": "event-0002"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:cancel"))
        .and(body_partial_json(serde_json::json!({
            "type": "cancel",
            "commandId": "command-cancel-001",
            "providerRunId": "provider-run-demo",
            "reason": "userRequested",
            "expectedRevision": 2
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "cancelRequested",
            "revision": 3,
            "duplicate": false
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = connected_client(&server).await;
    let context = ProviderArtifactRef::new(
        "artifact-context-demo",
        "task-demo",
        ProviderArtifactKind::Evidence,
        1,
        ProviderArtifactRetention::Task,
        90,
    )
    .expect("context artifact");
    let started = client
        .start(
            ProviderRunStartRequest::new(
                binding(),
                "command-start-001",
                "task-demo:start:1",
                "sha256:request-demo",
                "Produce the requested result.",
                vec![context],
            )
            .expect("start request"),
        )
        .await
        .expect("start");
    let snapshot = client
        .read(
            ProviderRunReadRequest::new(binding(), "command-read-001", started.provider_run_id())
                .expect("read request"),
        )
        .await
        .expect("read");
    let events = client
        .list_events(
            ProviderRunEventsRequest::new(
                binding(),
                "command-events-001",
                started.provider_run_id(),
                None,
                100,
            )
            .expect("events request"),
        )
        .await
        .expect("events");
    let cancelled = client
        .cancel(
            ProviderRunCancelRequest::new(
                binding(),
                "command-cancel-001",
                started.provider_run_id(),
                "userRequested",
                snapshot.revision(),
            )
            .expect("cancel request"),
        )
        .await
        .expect("cancel");

    assert!(started.created());
    assert_eq!(snapshot.status(), ProviderRunStatus::Running);
    assert_eq!(events.last_cursor(), Some("event-0002"));
    assert!(matches!(
        events.events()[1].payload(),
        ProviderRunEventPayload::Progress { summary } if summary == "working"
    ));
    assert_eq!(cancelled.status(), ProviderRunCancelStatus::CancelRequested);

    let authorization_requests = client
        .authorizer
        .requests
        .lock()
        .expect("requests lock")
        .clone();
    assert_eq!(authorization_requests.len(), 5);
    assert_eq!(
        authorization_requests[0],
        ProviderAuthorizationRequest::Discovery(DiscoveryAuthorizationOperation::ReadDescriptor)
    );
    for (request, operation) in authorization_requests[1..].iter().zip([
        RunAuthorizationOperation::Start,
        RunAuthorizationOperation::Read,
        RunAuthorizationOperation::ListEvents,
        RunAuthorizationOperation::Cancel,
    ]) {
        let ProviderAuthorizationRequest::Run {
            operation: actual,
            binding: actual_binding,
        } = request
        else {
            panic!("expected run authorization request");
        };
        assert_eq!(*actual, operation);
        assert_eq!(actual_binding.task_id(), "task-demo");
        assert_eq!(actual_binding.credential_id(), "credential-demo");
        assert_eq!(actual_binding.credential_revision(), 7);
        assert_eq!(actual_binding.resource(), binding().resource());
    }
    let requests = server.received_requests().await.expect("received requests");
    assert_eq!(requests.len(), 5);
    for request in requests {
        assert_eq!(
            request.headers["authorization"]
                .to_str()
                .expect("authorization"),
            "Bearer service-run-token"
        );
        assert_eq!(
            request.headers["x-crewon-delegation"]
                .to_str()
                .expect("delegation"),
            "delegation-run-token"
        );
        let body = String::from_utf8(request.body).expect("JSON body");
        assert!(!body.contains("service-run-token"));
        assert!(!body.contains("delegation-run-token"));
        assert!(!body.contains("credential-demo"));
        assert!(!body.contains("workspaceRoot"));
    }
}

#[tokio::test]
async fn durable_start_maps_provider_unavailable_without_retrying() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:start"))
        .respond_with(ResponseTemplate::new(503).set_body_json(serde_json::json!({
            "code": "providerUnavailable",
            "retryable": true,
            "providerRunId": null,
            "traceId": "trace-unavailable"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client = connected_client(&server).await;
    let request = ProviderRunStartRequest::new(
        binding(),
        "command-start-001",
        "task-demo:start:1",
        "sha256:request-demo",
        "Produce the requested result.",
        Vec::new(),
    )
    .expect("start request");

    assert_eq!(
        client.start(request).await,
        Err(AgentPlatformProviderError::Unavailable)
    );
    assert_eq!(
        server
            .received_requests()
            .await
            .expect("received requests")
            .iter()
            .filter(|request| request.url.path() == "/provider/v3/runs:start")
            .count(),
        1
    );
}

#[tokio::test]
async fn durable_start_rejects_non_json_response_before_deserialization() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:start"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            r#"{"providerRunId":"provider-run-demo","attemptId":"attempt-demo-001","created":true}"#,
            "text/plain",
        ))
        .expect(1)
        .mount(&server)
        .await;
    let client = connected_client(&server).await;
    let request = ProviderRunStartRequest::new(
        binding(),
        "command-start-001",
        "task-demo:start:1",
        "sha256:request-demo",
        "Produce the requested result.",
        Vec::new(),
    )
    .expect("start request");

    assert_eq!(
        client.start(request).await,
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

#[tokio::test]
async fn durable_start_maps_canonical_unknown_outcome_without_retrying() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:start"))
        .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
            "code": "unknownOutcome",
            "retryable": false,
            "providerRunId": null,
            "traceId": "trace-unknown"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client = connected_client(&server).await;
    let request = ProviderRunStartRequest::new(
        binding(),
        "command-start-001",
        "task-demo:start:1",
        "sha256:request-demo",
        "Produce the requested result.",
        Vec::new(),
    )
    .expect("start request");

    assert_eq!(
        client.start(request).await,
        Err(AgentPlatformProviderError::UnknownOutcome)
    );
}
