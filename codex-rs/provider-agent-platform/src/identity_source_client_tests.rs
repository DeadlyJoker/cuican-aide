use std::net::IpAddr;
use std::sync::Mutex;

use crewon_provider_transport::EndpointResolver;
use crewon_provider_transport::ProviderEndpointPolicy;
use crewon_provider_transport::ProviderEndpointPolicyError;
use pretty_assertions::assert_eq;
use serde_json::Value;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use crate::AgentPlatformIdentitySourceClient;
use crate::AgentPlatformProviderError;
use crate::IdentitySourceAuthorizationError;
use crate::IdentitySourceAuthorizationHeaders;
use crate::IdentitySourceAuthorizationRequest;
use crate::IdentitySourceAuthorizer;
use crate::IdentitySourcePrincipalAssertion;
use crate::IdentitySourceServiceToken;
use crate::ProviderIdentitySourceOwner;

const CANONICAL: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");
const SOURCE_BINDING_ID: &str = "019f6f00-0000-7000-8000-000000000001";
const ACTOR_ID: &str = "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f";

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
    requests: Mutex<Vec<IdentitySourceAuthorizationRequest>>,
}

impl IdentitySourceAuthorizer for RecordingAuthorizer {
    async fn authorize(
        &self,
        request: IdentitySourceAuthorizationRequest,
    ) -> Result<IdentitySourceAuthorizationHeaders, IdentitySourceAuthorizationError> {
        let principal_assertion = matches!(
            request,
            IdentitySourceAuthorizationRequest::Resolve { .. }
                | IdentitySourceAuthorizationRequest::SessionIssue { .. }
        );
        self.requests.lock().expect("request lock").push(request);
        if principal_assertion {
            IdentitySourceAuthorizationHeaders::session_issue(
                IdentitySourceServiceToken::new("identity-service-token")?,
                IdentitySourcePrincipalAssertion::new("identity-principal-token")?,
            )
        } else {
            IdentitySourceAuthorizationHeaders::read(IdentitySourceServiceToken::new(
                "identity-service-token",
            )?)
        }
    }
}

#[tokio::test]
async fn principal_session_and_revocation_client_keep_authority_and_cursors_exact() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/principal-sessions:issue"))
        .and(body_json(
            serde_json::json!({"sourceBindingId": SOURCE_BINDING_ID}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "token": "signed-principal-session",
            "expiresAt": 1_785_003_600_i64,
            "sourceBindingId": SOURCE_BINDING_ID,
            "sourceRevision": 1
        })))
        .expect(1)
        .mount(&server)
        .await;
    let stream_id = "019f6f00-0000-7000-8000-000000000010";
    let session_jti = "019f6f00-0000-7000-8000-000000000011";
    Mock::given(method("POST"))
        .and(path("/identity/v1/principal-revocations:snapshot"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "streamId": stream_id,
            "watermarkSequence": 1,
            "data": [{
                "sequence": 1,
                "issuer": "agent-platform",
                "sessionJti": session_jti,
                "expiresAt": 1_785_003_600_i64,
                "revokedAt": 1_785_000_060_i64
            }],
            "nextAfterSequence": null
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/principal-revocations:read"))
        .and(body_json(serde_json::json!({
            "cursor": {"streamId": stream_id, "sequence": 1},
            "limit": 10
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [],
            "cursor": {"streamId": stream_id, "sequence": 1}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = connected_identity_client(&server).await;
    let issued = client
        .issue_principal_session(SOURCE_BINDING_ID, owner())
        .await
        .expect("issue session");
    assert_eq!(
        issued.token.reveal_for_transport(),
        "signed-principal-session"
    );
    let snapshot = client
        .principal_revocation_snapshot(0, None, 10, /*now*/ 1_785_000_061)
        .await
        .expect("snapshot");
    assert_eq!(snapshot.data.len(), 1);
    assert_eq!(snapshot.data[0].session_jti(), session_jti);
    let cursor = snapshot
        .continuation_cursor()
        .expect("valid snapshot cursor")
        .expect("complete snapshot");
    let page = client
        .principal_revocation_read(&cursor, 10, /*now*/ 1_785_000_061)
        .await
        .expect("read revocations");
    assert_eq!(page.cursor, cursor);

    let requests = client.authorizer.requests.lock().expect("request lock");
    assert!(matches!(
        &requests[0],
        IdentitySourceAuthorizationRequest::SessionIssue { source_binding_id, .. }
            if source_binding_id == SOURCE_BINDING_ID
    ));
    assert!(matches!(
        &requests[1],
        IdentitySourceAuthorizationRequest::RevocationRead
    ));
    assert!(matches!(
        &requests[2],
        IdentitySourceAuthorizationRequest::RevocationRead
    ));
}

#[tokio::test]
async fn principal_revocation_client_rejects_watermark_and_sequence_drift() {
    let watermark_drift = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/principal-revocations:snapshot"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "streamId": "019f6f00-0000-7000-8000-000000000010",
            "watermarkSequence": 3,
            "data": [],
            "nextAfterSequence": null
        })))
        .expect(1)
        .mount(&watermark_drift)
        .await;
    assert_eq!(
        connected_identity_client(&watermark_drift)
            .await
            .principal_revocation_snapshot(
                /*after_sequence*/ 1,
                /*watermark_sequence*/ Some(2),
                /*limit*/ 10,
                /*now*/ 1_785_000_061,
            )
            .await,
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let sequence_regression = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/principal-revocations:snapshot"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "streamId": "019f6f00-0000-7000-8000-000000000010",
            "watermarkSequence": 2,
            "data": [{
                "sequence": 1,
                "issuer": "agent-platform",
                "sessionJti": "019f6f00-0000-7000-8000-000000000011",
                "expiresAt": 1_785_003_600_i64,
                "revokedAt": 1_785_000_060_i64
            }],
            "nextAfterSequence": null
        })))
        .expect(1)
        .mount(&sequence_regression)
        .await;
    assert_eq!(
        connected_identity_client(&sequence_regression)
            .await
            .principal_revocation_snapshot(
                /*after_sequence*/ 1,
                /*watermark_sequence*/ Some(2),
                /*limit*/ 10,
                /*now*/ 1_785_000_061,
            )
            .await,
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

#[tokio::test]
async fn identity_source_client_resolves_and_reads_with_separate_sensitive_authority() {
    let server = MockServer::start().await;
    let canonical: Value = serde_json::from_str(CANONICAL).expect("canonical");
    Mock::given(method("POST"))
        .and(path("/identity/v1/identity-bindings:resolve"))
        .respond_with(ResponseTemplate::new(200).set_body_json(canonical.clone()))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/identity-bindings:read"))
        .and(body_json(serde_json::json!({
            "sourceBindingId": SOURCE_BINDING_ID,
            "expectedLocalOwner": {
                "actorId": ACTOR_ID,
                "tenantId": "7",
                "spaceId": "11"
            }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(canonical))
        .expect(1)
        .mount(&server)
        .await;

    let source_client = connected_identity_client(&server).await;
    let resolved = source_client
        .resolve(owner(), /*now*/ 1_785_000_061)
        .await
        .expect("resolve");
    let read = source_client
        .read(SOURCE_BINDING_ID, owner(), /*now*/ 1_785_000_061)
        .await
        .expect("read");
    assert_eq!(resolved, read);

    {
        let authorization_requests = source_client
            .authorizer
            .requests
            .lock()
            .expect("request lock");
        assert_eq!(authorization_requests.len(), 2);
        assert!(matches!(
            &authorization_requests[0],
            IdentitySourceAuthorizationRequest::Resolve { owner: actual } if *actual == owner()
        ));
        assert!(matches!(
            &authorization_requests[1],
            IdentitySourceAuthorizationRequest::Read { source_binding_id, owner: actual }
                if source_binding_id == SOURCE_BINDING_ID && *actual == owner()
        ));
    }

    let requests = server.received_requests().await.expect("requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].headers["authorization"]
            .to_str()
            .expect("service header"),
        "Bearer identity-service-token"
    );
    assert_eq!(
        requests[0].headers["x-crewon-principal-assertion"]
            .to_str()
            .expect("principal header"),
        "identity-principal-token"
    );
    assert!(
        requests[1]
            .headers
            .get("x-crewon-principal-assertion")
            .is_none()
    );
    let read_body = String::from_utf8(requests[1].body.clone()).expect("read body");
    assert!(!read_body.contains("identity-service-token"));
    assert!(!read_body.contains("identity-principal-token"));
}

#[tokio::test]
async fn identity_source_read_rejects_source_mix_up_and_maps_unavailable() {
    let server = MockServer::start().await;
    let canonical: Value = serde_json::from_str(CANONICAL).expect("canonical");
    Mock::given(method("POST"))
        .and(path("/identity/v1/identity-bindings:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(canonical))
        .expect(1)
        .mount(&server)
        .await;
    let source_client = connected_identity_client(&server).await;
    assert_eq!(
        source_client
            .read(
                "019f6f00-0000-7000-8000-000000000099",
                owner(),
                /*now*/ 1_785_000_061,
            )
            .await,
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let unavailable = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/identity/v1/identity-bindings:read"))
        .respond_with(ResponseTemplate::new(503).set_body_json(serde_json::json!({
            "code": "unavailable",
            "retryable": true,
            "traceId": "trace-unavailable"
        })))
        .expect(1)
        .mount(&unavailable)
        .await;
    assert_eq!(
        connected_identity_client(&unavailable)
            .await
            .read(SOURCE_BINDING_ID, owner(), /*now*/ 1_785_000_061)
            .await,
        Err(AgentPlatformProviderError::Unavailable)
    );
}

fn owner() -> ProviderIdentitySourceOwner {
    ProviderIdentitySourceOwner::new(ACTOR_ID, "7", "11").expect("owner")
}

async fn connected_identity_client(
    server: &MockServer,
) -> AgentPlatformIdentitySourceClient<RecordingAuthorizer> {
    let policy = ProviderEndpointPolicy::development_loopback();
    let endpoint = policy
        .validate(
            &format!("{}/identity/v1/", server.uri()),
            &FixedResolver(server.address().ip()),
        )
        .await
        .expect("endpoint");
    AgentPlatformIdentitySourceClient::connect(policy, endpoint, RecordingAuthorizer::default())
        .expect("identity source client")
}
