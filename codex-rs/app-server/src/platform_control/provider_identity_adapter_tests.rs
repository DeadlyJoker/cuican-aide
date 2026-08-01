use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderAuthorizationIdentitySpec;
use crewon_secrets::CredentialOwner;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::ProviderIdentityBindingRevokeOutcome;
use crewon_state::ProviderIdentityBindingRevokeRequest;
use crewon_state::ProviderIdentityBindingStatus;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;

use super::ConnectionRequestIdentity;
use super::authenticated_principal::AuthenticatedPrincipal;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::authenticated_principal::AuthenticatedPrincipalSource;
use super::authenticated_principal::AuthenticatedPrincipalSpec;
use super::credential_adapter::credential_owner;
use super::provider_identity_adapter::ProviderIdentityAdapterError;
use super::provider_identity_adapter::resolve_provider_authorization_identity;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSettings;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSupervisor;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadRequest;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReader;
use super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;
use crate::transport::ConnectionOrigin;

#[tokio::test]
async fn active_mapping_resolves_for_authenticated_identity_and_exact_credential_owner() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("trace-1");
    let owner = credential_owner(&identity).expect("credential owner");
    let record = binding(&identity);
    assert_eq!(
        state
            .create_provider_identity_binding_record(&record)
            .await
            .expect("create binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );

    let resolved = resolve_provider_authorization_identity(
        &state, &identity, &owner, &ready, /*now*/ 150,
    )
    .await
    .expect("resolve provider identity");
    let expected = ProviderAuthorizationIdentity::new(ProviderAuthorizationIdentitySpec {
        subject: "user:42".to_string(),
        tenant_id: "7".to_string(),
        space_id: "11".to_string(),
    })
    .expect("expected provider identity");
    assert_eq!(resolved, expected);
    let debug = format!("{resolved:?}");
    assert!(!debug.contains("user:42"));
    assert!(!debug.contains("tenant-local-1"));

    assert_eq!(
        resolve_provider_authorization_identity(
            &state, &identity, &owner, &ready, /*now*/ 200
        )
        .await
        .expect_err("stale mapping rejected"),
        ProviderIdentityAdapterError::MappingNotFound
    );

    let other_scope_identity = authenticated_identity_in_space("trace-2", "space-local-2");
    let other_scope_owner =
        credential_owner(&other_scope_identity).expect("other scope credential owner");
    assert_eq!(
        resolve_provider_authorization_identity(
            &state,
            &other_scope_identity,
            &other_scope_owner,
            &ready,
            /*now*/ 150,
        )
        .await
        .expect_err("cross-space mapping rejected"),
        ProviderIdentityAdapterError::MappingNotFound
    );

    state.close().await;
}

#[tokio::test]
async fn resolver_rejects_connection_identity_owner_mix_up_and_missing_mapping() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let connection_identity = ConnectionRequestIdentity::new(ConnectionOrigin::WebSocket)
        .derive(declared_client(), "trace-connection".to_string());
    let connection_owner = credential_owner(&connection_identity).expect("connection owner");
    assert_eq!(
        resolve_provider_authorization_identity(
            &state,
            &connection_identity,
            &connection_owner,
            &ready,
            /*now*/ 150,
        )
        .await
        .expect_err("connection identity rejected"),
        ProviderIdentityAdapterError::Unauthenticated
    );

    let identity = authenticated_identity("trace-authenticated");
    let owner = credential_owner(&identity).expect("credential owner");
    assert_eq!(
        resolve_provider_authorization_identity(
            &state, &identity, &owner, &ready, /*now*/ 150
        )
        .await
        .expect_err("missing mapping rejected"),
        ProviderIdentityAdapterError::MappingNotFound
    );

    let wrong_owner = CredentialOwner::space_user(
        format!("principal:{}", "b".repeat(64)),
        "tenant-local-1",
        "space-local-1",
    )
    .expect("wrong owner");
    assert_eq!(
        resolve_provider_authorization_identity(
            &state,
            &identity,
            &wrong_owner,
            &ready,
            /*now*/ 150,
        )
        .await
        .expect_err("owner mix-up rejected"),
        ProviderIdentityAdapterError::CredentialOwnerMismatch
    );

    state.close().await;
}

#[tokio::test]
async fn revoked_mapping_cannot_resolve_provider_authority() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("trace-1");
    let owner = credential_owner(&identity).expect("credential owner");
    let record = binding(&identity);
    state
        .create_provider_identity_binding_record(&record)
        .await
        .expect("create binding");
    assert_eq!(
        state
            .revoke_provider_identity_binding_record(&ProviderIdentityBindingRevokeRequest {
                binding_id: record.binding_id,
                expected_revision: 1,
                authority_id: record.authority_id,
                source_revision: 2,
                source_fresh_until: 161,
                updated_at: 101,
            })
            .await
            .expect("revoke binding"),
        ProviderIdentityBindingRevokeOutcome::Revoked
    );

    assert_eq!(
        resolve_provider_authorization_identity(
            &state, &identity, &owner, &ready, /*now*/ 150
        )
        .await
        .expect_err("revoked mapping rejected"),
        ProviderIdentityAdapterError::MappingNotFound
    );

    state.close().await;
}

pub(super) fn authenticated_identity(trace_id: &str) -> super::RequestIdentity {
    authenticated_identity_in_space(trace_id, "space-local-1")
}

pub(crate) fn authenticated_identity_in_space(
    trace_id: &str,
    space_id: &str,
) -> super::RequestIdentity {
    ConnectionRequestIdentity::new_authenticated(
        ConnectionOrigin::WebSocket,
        AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
            source: AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            issuer: "https://identity.example".to_string(),
            audience: "crewon-app-server".to_string(),
            subject: "identity-user-42".to_string(),
            tenant_id: "tenant-local-1".to_string(),
            space_id: space_id.to_string(),
            token_id: "token-jti-redacted".to_string(),
            issued_at: 100,
            expires_at: 200,
            binding: AuthenticatedPrincipalBinding::AgentPlatform {
                source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
                source_revision: 1,
            },
        })
        .expect("authenticated principal"),
    )
    .derive(declared_client(), trace_id.to_string())
}

pub(super) fn declared_client() -> RequestIdentityClientRef {
    RequestIdentityClientRef {
        name: "provider-identity-adapter-test".to_string(),
        version: "1.0.0".to_string(),
        capabilities: RequestIdentityClientCapabilitiesRef {
            experimental_api: true,
            request_attestation: false,
        },
    }
}

pub(super) fn binding(identity: &super::RequestIdentity) -> ProviderIdentityBindingRecord {
    let reference = identity.reference();
    let mut record = ProviderIdentityBindingRecord {
        binding_id: "identity-binding-1".to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: reference.tenant_id.clone().expect("tenant"),
        local_space_id: reference.space_id.clone().expect("space"),
        provider_id: "agent-platform".to_string(),
        provider_subject: "user:42".to_string(),
        provider_tenant_id: "7".to_string(),
        provider_space_id: "11".to_string(),
        authority_id: "crewon-identity-session".to_string(),
        source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
        source_revision: 1,
        source_fresh_until: 200,
        revision: 1,
        status: ProviderIdentityBindingStatus::Active,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    record.record_hash = record.canonical_hash();
    record
}

async fn initialized(home: &tempfile::TempDir) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}

struct NoopIdentitySourceReader;

impl ProviderIdentitySourceReader for NoopIdentitySourceReader {
    async fn read(
        &self,
        _request: ProviderIdentitySourceReadRequest,
        _now: i64,
    ) -> Result<
        crewon_provider_agent_platform::ProviderIdentitySourceSnapshot,
        ProviderIdentitySourceReadError,
    > {
        Err(ProviderIdentitySourceReadError)
    }
}

pub(super) async fn ready_mappings(state: &StateRuntime) -> ReadyProviderIdentityMappings {
    ProviderIdentityRefreshSupervisor::new(
        state,
        &NoopIdentitySourceReader,
        ProviderIdentityRefreshSettings::new(/*page_size*/ 10, /*max_bindings*/ 100)
            .expect("refresh settings"),
    )
    .refresh_all(/*now*/ 100)
    .await
    .expect("empty refresh")
}
