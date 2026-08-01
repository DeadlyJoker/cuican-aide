use std::sync::Arc;
use std::sync::Mutex;

use pretty_assertions::assert_eq;

use super::BootstrapSessionIssuer;
use super::BootstrapSessionIssuerError;
use super::IssuedBootstrapSession;
use super::map_exchange_error;
use super::persist_resolved_provider_identity;
use super::principal_session_exchange_service;
use crewon_app_server_transport::PrincipalSessionExchangeError;
use crewon_provider_agent_platform::ProviderIdentitySourceOwner;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::ProviderIdentityBindingStatus;
use crewon_state::StateRuntime;

const IDENTITY_SOURCE_FIXTURE: &str =
    include_str!("../../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");

struct RecordingIssuer {
    received: Mutex<Vec<String>>,
    result: Result<IssuedBootstrapSession, BootstrapSessionIssuerError>,
}

impl BootstrapSessionIssuer for RecordingIssuer {
    async fn issue(
        &self,
        bootstrap_token: String,
    ) -> Result<IssuedBootstrapSession, BootstrapSessionIssuerError> {
        self.received
            .lock()
            .expect("received lock")
            .push(bootstrap_token);
        match &self.result {
            Ok(issued) => IssuedBootstrapSession::new(issued.token.clone(), issued.expires_at),
            Err(error) => Err(*error),
        }
    }
}

#[test]
fn exchange_error_mapping_is_exhaustive_and_stable() {
    assert_eq!(
        [
            map_exchange_error(BootstrapSessionIssuerError::Unauthorized),
            map_exchange_error(BootstrapSessionIssuerError::Conflict),
            map_exchange_error(BootstrapSessionIssuerError::Unavailable),
        ],
        [
            PrincipalSessionExchangeError::Unauthorized,
            PrincipalSessionExchangeError::Conflict,
            PrincipalSessionExchangeError::Unavailable,
        ]
    );
}

#[tokio::test]
async fn exchange_service_passes_bootstrap_once_and_returns_only_session_material() {
    let issuer = Arc::new(RecordingIssuer {
        received: Mutex::new(Vec::new()),
        result: Ok(IssuedBootstrapSession::new(
            "signed-session".to_string(),
            /*expires_at*/ 1_900_000_000,
        )
        .expect("issued session")),
    });
    let service = principal_session_exchange_service(issuer.clone());

    let issued = service
        .exchange("signed-bootstrap".to_string())
        .await
        .expect("exchange");

    assert_eq!(issued.reveal_token_for_transport(), "signed-session");
    assert_eq!(issued.expires_at(), 1_900_000_000);
    assert_eq!(
        *issuer.received.lock().expect("received lock"),
        ["signed-bootstrap"]
    );
    assert_eq!(
        format!("{service:?}"),
        "PrincipalSessionExchangeService([REDACTED])"
    );
}

#[tokio::test]
async fn resolved_identity_is_persisted_before_it_can_authorize_provider_requests() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = StateRuntime::init(home.path().to_path_buf(), "provider-test".to_string())
        .await
        .expect("initialize state");
    let owner = ProviderIdentitySourceOwner::new(
        "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f",
        "7",
        "11",
    )
    .expect("source owner");
    let snapshot = ProviderIdentitySourceSnapshot::parse(
        IDENTITY_SOURCE_FIXTURE.as_bytes(),
        /*now*/ 1_785_000_061,
    )
    .expect("source snapshot");

    persist_resolved_provider_identity(&state, &owner, &snapshot)
        .await
        .expect("persist source snapshot");

    let lookup = ProviderIdentityBindingLookup {
        local_actor_id: owner.actor_id().to_string(),
        local_tenant_id: owner.tenant_id().to_string(),
        local_space_id: owner.space_id().to_string(),
        provider_id: "agent-platform".to_string(),
    };
    let mut expected = ProviderIdentityBindingRecord {
        binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
        local_actor_id: lookup.local_actor_id.clone(),
        local_tenant_id: lookup.local_tenant_id.clone(),
        local_space_id: lookup.local_space_id.clone(),
        provider_id: lookup.provider_id.clone(),
        provider_subject: "user:42".to_string(),
        provider_tenant_id: "7".to_string(),
        provider_space_id: "11".to_string(),
        authority_id: "agent-platform-identity".to_string(),
        source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
        source_revision: 1,
        source_fresh_until: 1_785_000_120,
        revision: 1,
        status: ProviderIdentityBindingStatus::Active,
        record_hash: String::new(),
        created_at: 1_785_000_000,
        updated_at: 1_785_000_000,
    };
    expected.record_hash = expected.canonical_hash();
    assert_eq!(
        state
            .get_active_provider_identity_binding_record(&lookup, /*now*/ 1_785_000_061)
            .await
            .expect("read mapping"),
        Some(expected)
    );
    state.close().await;
}

#[tokio::test]
async fn resolved_identity_owner_drift_is_rejected_without_persisting_authority() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = StateRuntime::init(home.path().to_path_buf(), "provider-test".to_string())
        .await
        .expect("initialize state");
    let wrong_owner = ProviderIdentitySourceOwner::new(
        "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f",
        "7",
        "12",
    )
    .expect("wrong owner");
    let snapshot = ProviderIdentitySourceSnapshot::parse(
        IDENTITY_SOURCE_FIXTURE.as_bytes(),
        /*now*/ 1_785_000_061,
    )
    .expect("source snapshot");

    assert_eq!(
        persist_resolved_provider_identity(&state, &wrong_owner, &snapshot)
            .await
            .expect_err("owner drift rejected"),
        BootstrapSessionIssuerError::Conflict
    );
    assert_eq!(
        state
            .get_provider_identity_binding_record(snapshot.binding().source_binding_id())
            .await
            .expect("read mapping"),
        None
    );
    state.close().await;
}
