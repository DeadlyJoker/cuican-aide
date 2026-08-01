use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

use super::*;
use crate::AgentPlatformCapability;
use crate::ProviderRunAuthorizationBinding;
use crate::ProviderRunEventPage;
use crate::ProviderRunEventPayload;
use crate::run_event_wire::EventHttpWire;
use crate::run_event_wire::EventsResponseWire;
use crate::wire::ProviderDescriptorWire;
use crate::wire::ProviderErrorWire;

const RUN_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_contract.v3.json");

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ApprovalCommandType {
    DecideApproval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ApprovalDecisionWire {
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalCommandWire {
    #[serde(rename = "type")]
    command_type: ApprovalCommandType,
    command_id: String,
    provider_run_id: String,
    approval_id: String,
    decision: ApprovalDecisionWire,
    action_digest: String,
    idempotency_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ToolResultCommandType {
    SubmitToolResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolResultCommandWire {
    #[serde(rename = "type")]
    command_type: ToolResultCommandType,
    command_id: String,
    provider_run_id: String,
    tool_call_id: String,
    intent_digest: String,
    result_digest: String,
    artifact: ArtifactRefWire,
    idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalProviderWire {
    provider_id: String,
    capabilities: Vec<AgentPlatformCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalCredentialWire {
    credential_id: String,
    owner_subject: String,
    revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalDelegationWire {
    audience: String,
    jti: String,
    expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalAuthorizationWire {
    service_audience: String,
    tenant_id: String,
    space_id: String,
    task_id: String,
    subject: String,
    scopes: Vec<String>,
    purpose: String,
    credential: CanonicalCredentialWire,
    delegation: CanonicalDelegationWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalRunContractWire {
    schema_version: String,
    provider: CanonicalProviderWire,
    authorization: CanonicalAuthorizationWire,
    commands: Vec<Value>,
    events: Vec<Value>,
    error: ProviderErrorWire,
}

#[test]
fn canonical_run_fixture_round_trips_as_one_strict_top_level_object() {
    let fixture: Value = serde_json::from_str(RUN_FIXTURE).expect("fixture");
    let decoded: CanonicalRunContractWire =
        serde_json::from_value(fixture.clone()).expect("strict top-level contract");
    assert_eq!(serde_json::to_value(decoded).expect("encode"), fixture);

    let mut forged = fixture;
    forged["authorization"]["workspaceRoot"] = Value::String("/private/path".to_string());
    assert!(serde_json::from_value::<CanonicalRunContractWire>(forged).is_err());
}

#[test]
fn canonical_run_commands_round_trip_exactly() {
    let fixture: Value = serde_json::from_str(RUN_FIXTURE).expect("fixture");
    let commands = fixture["commands"].as_array().expect("commands");

    round_trip::<StartCommandWire>(&commands[0]);
    round_trip::<ReadCommandWire>(&commands[1]);
    round_trip::<ListEventsCommandWire>(&commands[2]);
    round_trip::<CancelCommandWire>(&commands[3]);
    round_trip::<ApprovalCommandWire>(&commands[4]);
    round_trip::<ToolResultCommandWire>(&commands[5]);
    round_trip::<ProviderErrorWire>(&fixture["error"]);
}

#[test]
fn canonical_events_map_from_http_envelope_to_contiguous_typed_page() {
    let fixture: Value = serde_json::from_str(RUN_FIXTURE).expect("fixture");
    let events = fixture["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(canonical_event_http_envelope)
        .map(|event| {
            serde_json::from_str::<EventHttpWire>(&event.to_string())
                .expect("event HTTP envelope")
                .into_domain("task-demo")
                .expect("typed event")
        })
        .collect::<Vec<_>>();
    let page = ProviderRunEventPage::validated(
        events,
        Some("event-0006".to_string()),
        "provider-run-demo",
        None,
    )
    .expect("typed event page");

    assert_eq!(page.events().len(), 6);
    assert!(matches!(
        page.events()[2].payload(),
        ProviderRunEventPayload::ApprovalRequired { .. }
    ));
    assert!(matches!(
        page.events()[3].payload(),
        ProviderRunEventPayload::ToolResultRequired { .. }
    ));
    assert!(matches!(
        page.events()[5].payload(),
        ProviderRunEventPayload::Completed { .. }
    ));
}

#[test]
fn event_wire_rejects_unknown_payload_fields_cursor_drift_and_missing_capability() {
    let fixture: Value = serde_json::from_str(RUN_FIXTURE).expect("fixture");
    let mut event = canonical_event_http_envelope(&fixture["events"][1]);
    event["payload"]["secretDetail"] = Value::String("must be rejected".to_string());
    let wire: EventHttpWire = serde_json::from_value(event).expect("outer envelope");
    assert_eq!(
        wire.into_domain("task-demo"),
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let mut event = canonical_event_http_envelope(&fixture["events"][1]);
    event["cursor"] = Value::String("event-0003".to_string());
    let wire: EventHttpWire = serde_json::from_value(event).expect("outer envelope");
    assert_eq!(
        wire.into_domain("task-demo"),
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let approval = canonical_event_http_envelope(&fixture["events"][2]);
    let wire: EventsResponseWire = serde_json::from_value(serde_json::json!({
        "events": [approval],
        "lastCursor": "event-0003"
    }))
    .expect("events response");
    let request = ProviderRunEventsRequest::new(
        binding(),
        "command-events-001",
        "provider-run-demo",
        Some("event-0002".to_string()),
        100,
    )
    .expect("events request");
    let discovery: Value = serde_json::from_str(include_str!(
        "../../app-server-protocol/schema/canonical/provider_discovery.v1.json"
    ))
    .expect("discovery fixture");
    let descriptor: ProviderDescriptorWire =
        serde_json::from_value(discovery["descriptor"].clone()).expect("descriptor");
    assert_eq!(
        wire.into_domain(
            &request,
            &descriptor.validate().expect("descriptor validation")
        ),
        Err(AgentPlatformProviderError::Incompatible)
    );
}

#[test]
fn event_wire_rejects_duplicate_keys_inside_raw_payload() {
    let raw = r#"{
        "eventId":"event-demo-002",
        "providerRunId":"provider-run-demo",
        "attemptId":"attempt-demo-001",
        "sequence":2,
        "cursor":"event-0002",
        "schemaVersion":"3.0.0",
        "type":"progress",
        "payload":{"summary":"first","summary":"second"},
        "createdAt":101
    }"#;
    let event: EventHttpWire = serde_json::from_str(raw).expect("outer event envelope");
    assert_eq!(
        event.into_domain("task-demo"),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

#[test]
fn run_http_responses_validate_identity_revision_status_and_timestamps() {
    let start: StartResponseWire = serde_json::from_value(serde_json::json!({
        "providerRunId": "provider-run-demo",
        "attemptId": "attempt-demo-001",
        "created": true
    }))
    .expect("start response");
    assert!(start.into_domain().expect("start result").created());

    let snapshot: ReadResponseWire = serde_json::from_value(serde_json::json!({
        "providerRunId": "provider-run-demo",
        "attemptId": "attempt-demo-001",
        "status": "running",
        "revision": 2,
        "lastSequence": 2,
        "createdAt": 100,
        "updatedAt": 110
    }))
    .expect("snapshot");
    assert_eq!(
        snapshot
            .into_domain("provider-run-demo")
            .expect("snapshot")
            .status(),
        ProviderRunStatus::Running
    );

    let drift: ReadResponseWire = serde_json::from_value(serde_json::json!({
        "providerRunId": "provider-run-other",
        "attemptId": "attempt-demo-001",
        "status": "running",
        "revision": 2,
        "lastSequence": 2,
        "createdAt": 110,
        "updatedAt": 100
    }))
    .expect("drift response");
    assert_eq!(
        drift.into_domain("provider-run-demo"),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

fn round_trip<T>(value: &Value)
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    let decoded: T = serde_json::from_value(value.clone()).expect("strict decode");
    assert_eq!(serde_json::to_value(decoded).expect("encode"), *value);
}

fn canonical_event_http_envelope(value: &Value) -> Value {
    let mut source = value.as_object().expect("canonical event object").clone();
    let mut envelope = Map::new();
    for key in [
        "eventId",
        "providerRunId",
        "attemptId",
        "sequence",
        "cursor",
        "createdAt",
        "type",
    ] {
        envelope.insert(
            key.to_string(),
            source.remove(key).expect("common event field"),
        );
    }
    envelope.insert(
        "schemaVersion".to_string(),
        Value::String("3.0.0".to_string()),
    );
    envelope.insert("payload".to_string(), Value::Object(source));
    Value::Object(envelope)
}
