use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderAuthorizationIdentitySpec;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_secrets::CredentialOwner;
use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::DurableWorkspaceRootResolveOutcome;
use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::ProviderConnectionRecord;
use crewon_state::ProviderConnectionResolveOutcome;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::ProviderIdentityBindingStatus;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingResolveOutcome;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;

use super::*;
use crate::platform_control::provider_access_grant_scope::agent_platform_scopes;

pub(in crate::task_control) const ACTOR_ID: &str =
    "principal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(in crate::task_control) const TENANT_ID: &str = "tenant-1";
pub(in crate::task_control) const SPACE_ID: &str = "space-1";
pub(in crate::task_control) const WORKSPACE_KEY: &str =
    "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001";
const CONNECTION_ID: &str = "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101";
const BINDING_ID: &str = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301";
pub(in crate::task_control) const GRANT_ID: &str =
    "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c102";
const SOURCE_BINDING_ID: &str = "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c103";

#[tokio::test]
async fn resolves_exact_secret_free_provider_run_authority() {
    let fixture = authority_fixture().await;

    let resolved = resolve_provider_run_authority(ProviderRunAuthorityRequest {
        state: fixture.state.as_ref(),
        binding: &fixture.binding,
        expected_binding_revision: Some(1),
        credential_id: GRANT_ID,
        credential_revision: 1,
        now: 150,
    })
    .await
    .expect("resolve Provider Run authority");

    assert_eq!(
        resolved.credential_owner(),
        &CredentialOwner::space_user(ACTOR_ID, TENANT_ID, SPACE_ID).expect("credential owner")
    );
    assert_eq!(resolved.credential_id(), GRANT_ID);
    assert_eq!(resolved.credential_revision(), 1);
    assert_eq!(
        resolved.authorization_identity(),
        &ProviderAuthorizationIdentity::new(ProviderAuthorizationIdentitySpec {
            subject: "user:42".to_string(),
            tenant_id: "7".to_string(),
            space_id: "11".to_string(),
        })
        .expect("Provider authorization identity")
    );
    assert_eq!(resolved.identity_binding_id(), "identity-binding-1");
    assert_eq!(resolved.identity_binding_revision(), 1);
    assert_eq!(
        format!("{resolved:?}"),
        "ResolvedProviderRunAuthority([REDACTED])"
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn rejects_connection_grant_identity_and_resource_drift() {
    let fixture = authority_fixture().await;

    assert_eq!(
        resolve_provider_run_authority(ProviderRunAuthorityRequest {
            state: fixture.state.as_ref(),
            binding: &fixture.binding,
            expected_binding_revision: Some(2),
            credential_id: GRANT_ID,
            credential_revision: 1,
            now: 150,
        })
        .await,
        Err(ProviderRunAuthorityError::BindingMismatch)
    );

    assert_eq!(
        resolve_provider_run_authority(ProviderRunAuthorityRequest {
            state: fixture.state.as_ref(),
            binding: &fixture.binding,
            expected_binding_revision: Some(1),
            credential_id: GRANT_ID,
            credential_revision: 2,
            now: 150,
        })
        .await,
        Err(ProviderRunAuthorityError::ConnectionMismatch)
    );
    assert_eq!(
        resolve_provider_run_authority(ProviderRunAuthorityRequest {
            state: fixture.state.as_ref(),
            binding: &fixture.binding,
            expected_binding_revision: Some(1),
            credential_id: GRANT_ID,
            credential_revision: 1,
            now: 1_500,
        })
        .await,
        Err(ProviderRunAuthorityError::GrantMismatch)
    );

    let drifted = cloud_agent_binding("agent-revision-2");
    assert_eq!(
        resolve_provider_run_authority(ProviderRunAuthorityRequest {
            state: fixture.state.as_ref(),
            binding: &drifted,
            expected_binding_revision: Some(1),
            credential_id: GRANT_ID,
            credential_revision: 1,
            now: 150,
        })
        .await,
        Err(ProviderRunAuthorityError::BindingMismatch)
    );

    fixture.state.close().await;
}

struct AuthorityFixture {
    _home: tempfile::TempDir,
    state: std::sync::Arc<StateRuntime>,
    binding: crewon_resource_federation::ResolvedResourceBinding,
}

async fn authority_fixture() -> AuthorityFixture {
    let home = tempfile::tempdir().expect("temporary state directory");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state");

    let binding = install_authority_records(state.as_ref()).await;

    AuthorityFixture {
        _home: home,
        state,
        binding,
    }
}

pub(in crate::task_control) async fn install_authority_records(
    state: &StateRuntime,
) -> crewon_resource_federation::ResolvedResourceBinding {
    let mut root = DurableWorkspaceRootRecord {
        workspace_key: WORKSPACE_KEY.to_string(),
        node_id: "node-1".to_string(),
        environment_id: "environment-1".to_string(),
        root_fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        record_hash: String::new(),
        created_at: 100,
    };
    root.record_hash = root.canonical_hash();
    assert_eq!(
        state
            .resolve_durable_workspace_root_record(&root)
            .await
            .expect("create workspace root"),
        DurableWorkspaceRootResolveOutcome::Created(root)
    );

    let mut identity = ProviderIdentityBindingRecord {
        binding_id: "identity-binding-1".to_string(),
        local_actor_id: ACTOR_ID.to_string(),
        local_tenant_id: TENANT_ID.to_string(),
        local_space_id: SPACE_ID.to_string(),
        provider_id: "agent-platform".to_string(),
        provider_subject: "user:42".to_string(),
        provider_tenant_id: "7".to_string(),
        provider_space_id: "11".to_string(),
        authority_id: "authority-1".to_string(),
        source_binding_id: SOURCE_BINDING_ID.to_string(),
        source_revision: 1,
        source_fresh_until: 1_000,
        revision: 1,
        status: ProviderIdentityBindingStatus::Active,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    identity.record_hash = identity.canonical_hash();
    assert_eq!(
        state
            .create_provider_identity_binding_record(&identity)
            .await
            .expect("create identity binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );

    let mut grant = ProviderAccessGrantRecord {
        grant_id: GRANT_ID.to_string(),
        local_actor_id: ACTOR_ID.to_string(),
        local_tenant_id: TENANT_ID.to_string(),
        local_space_id: SPACE_ID.to_string(),
        provider_id: "agent-platform".to_string(),
        source_binding_id: SOURCE_BINDING_ID.to_string(),
        source_revision: 1,
        granted_scopes: agent_platform_scopes(),
        status: ProviderAccessGrantStatus::Active,
        expires_at: 1_000,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        revoked_at: None,
    };
    grant.record_hash = grant.canonical_hash();
    assert_eq!(
        state
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create access grant"),
        ProviderAccessGrantResolveOutcome::Created(grant)
    );

    let mut connection = ProviderConnectionRecord {
        connection_id: CONNECTION_ID.to_string(),
        local_actor_id: ACTOR_ID.to_string(),
        local_tenant_id: TENANT_ID.to_string(),
        local_space_id: SPACE_ID.to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        credential_id: GRANT_ID.to_string(),
        credential_revision: 1,
        record_hash: String::new(),
        created_at: 100,
    };
    connection.record_hash = connection.canonical_hash();
    assert_eq!(
        state
            .resolve_provider_connection_record(&connection)
            .await
            .expect("create Provider connection"),
        ProviderConnectionResolveOutcome::Created(connection)
    );

    let binding = cloud_agent_binding("agent-revision-1");
    let mut stored_binding = ProviderResourceBindingRecord {
        binding_id: BINDING_ID.to_string(),
        local_actor_id: ACTOR_ID.to_string(),
        local_tenant_id: TENANT_ID.to_string(),
        local_space_id: SPACE_ID.to_string(),
        connection_id: CONNECTION_ID.to_string(),
        workspace_key: WORKSPACE_KEY.to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: ProviderResourceKind::Agent,
        resource_id: "agent-1".to_string(),
        resource_revision: "agent-revision-1".to_string(),
        binding_mode: ProviderResourceBindingMode::ProviderManaged,
        execution_location: ProviderResourceExecutionLocation::Provider,
        manifest_schema_version: "1".to_string(),
        content_digest: None,
        source_revision: None,
        source_digest: None,
        local_revision: None,
        local_content_digest: None,
        status: ProviderResourceBindingStatus::Active,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        unbound_at: None,
    };
    stored_binding.record_hash = stored_binding.canonical_hash();
    assert_eq!(
        state
            .resolve_provider_resource_binding_record(&stored_binding)
            .await
            .expect("create resource binding"),
        ProviderResourceBindingResolveOutcome::Created(stored_binding)
    );

    binding
}

fn cloud_agent_binding(revision: &str) -> crewon_resource_federation::ResolvedResourceBinding {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol version"),
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new("agent-1").expect("resource id"),
        revision: ResourceRevision::new(revision).expect("resource revision"),
    };
    resolve_binding(
        &BindingRequest {
            binding_id: BindingId::new(BINDING_ID).expect("binding id"),
            workspace_key: WorkspaceKey::new(WORKSPACE_KEY).expect("workspace key"),
            resource: resource.clone(),
            mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
            materialization: None,
        },
        &ResourceManifest {
            resource,
            schema_version: ManifestSchemaVersion::new("1").expect("manifest schema"),
            content_digest: None,
        },
        &ProviderCapabilities::new(
            provider,
            [Capability {
                resource_kind: ResourceKind::Agent,
                binding_mode: BindingMode::ProviderManaged,
                execution_location: ExecutionLocation::Provider,
            }],
        )
        .expect("provider capabilities"),
    )
    .expect("resolve binding")
}
