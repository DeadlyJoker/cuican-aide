use std::sync::Arc;

use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceType;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderError;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceListQuery;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourcePage;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantRevokeOutcome;
use crewon_state::ProviderAccessGrantRevokeRequest;
use crewon_state::ProviderConnectionRecord;
use crewon_state::ProviderConnectionResolveOutcome;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use pretty_assertions::assert_eq;
use tokio::sync::Mutex;

use super::provider_access_grant_authority_tests::discovery_grant;
use super::provider_access_grant_authority_tests::initialized;
use super::provider_connection_descriptor::LiveProviderDescriptor;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_descriptor::ProviderDescriptorReadError;
use super::provider_connection_descriptor::ProviderDescriptorReadRequest;
use super::provider_identity_adapter_tests::authenticated_identity;
use super::provider_identity_adapter_tests::authenticated_identity_in_space;
use super::provider_identity_adapter_tests::binding;
use super::provider_identity_adapter_tests::ready_mappings;
use super::provider_resource_catalog::ProviderResourceCatalog;
use super::provider_resource_catalog::ProviderResourceCatalogFactory;
use super::provider_resource_processor::ProviderResourceProcessor;
use super::provider_resource_processor::ProviderResourceProcessorError;

#[tokio::test]
async fn resource_catalog_rejects_invalid_owner_kind_and_authority_drift() {
    let fixture = Fixture::new().await;
    let resource = resource_ref();
    let revoke = ProviderAccessGrantRevokeRequest {
        grant_id: fixture.grant.grant_id.clone(),
        expected_revision: fixture.grant.revision,
        revoked_at: 151,
    };
    let catalog = RecordingCatalog::new(
        descriptor("3.0.0"),
        ResourcePage::complete(vec![resource.clone()]).expect("page"),
        resource_manifest(resource),
        CatalogAction::Revoke {
            state: Arc::clone(&fixture.state),
            request: revoke,
        },
    );
    let factory = RecordingCatalogFactory::new(catalog);
    let processor = ProviderResourceProcessor::new(
        fixture.state.as_ref(),
        &fixture.ready,
        &factory,
        &FixedClock,
    );

    let invalid_limit = processor
        .list(
            &fixture.identity,
            ResourceListParams {
                connection_id: fixture.connection.connection_id.clone(),
                cursor: None,
                limit: Some(0),
                resource_type: None,
            },
        )
        .await
        .expect_err("zero limit rejected");
    let unsupported_kind = processor
        .list(
            &fixture.identity,
            ResourceListParams {
                connection_id: fixture.connection.connection_id.clone(),
                cursor: None,
                limit: None,
                resource_type: Some(ResourceType::Skill),
            },
        )
        .await
        .expect_err("unsupported kind rejected");
    let cross_owner = processor
        .list(
            &authenticated_identity_in_space("provider-resource-other", "12"),
            ResourceListParams {
                connection_id: fixture.connection.connection_id.clone(),
                cursor: None,
                limit: None,
                resource_type: None,
            },
        )
        .await
        .expect_err("cross owner rejected");
    let authority_drift = processor
        .list(
            &fixture.identity,
            ResourceListParams {
                connection_id: fixture.connection.connection_id.clone(),
                cursor: None,
                limit: None,
                resource_type: Some(ResourceType::Agent),
            },
        )
        .await
        .expect_err("revoke during I/O rejected");

    assert_eq!(
        invalid_limit,
        ProviderResourceProcessorError::InvalidRequest
    );
    assert_eq!(
        unsupported_kind,
        ProviderResourceProcessorError::Incompatible
    );
    assert_eq!(cross_owner, ProviderResourceProcessorError::NotFound);
    assert_eq!(
        authority_drift,
        ProviderResourceProcessorError::AuthorityChanged
    );
    fixture.state.close().await;
}

pub(super) struct Fixture {
    _home: tempfile::TempDir,
    pub(super) state: Arc<crewon_state::StateRuntime>,
    pub(super) ready: super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings,
    pub(super) identity: super::RequestIdentity,
    pub(super) grant: crewon_state::ProviderAccessGrantRecord,
    pub(super) connection: ProviderConnectionRecord,
}

impl Fixture {
    pub(super) async fn new() -> Self {
        let home = tempfile::TempDir::new().expect("state home");
        let state = initialized(&home).await;
        let ready = ready_mappings(&state).await;
        let identity = authenticated_identity("provider-resource");
        assert_eq!(
            state
                .create_provider_identity_binding_record(&binding(&identity))
                .await
                .expect("create identity binding"),
            ProviderIdentityBindingCreateOutcome::Created
        );
        let grant = discovery_grant(&identity, /*expires_at*/ 190);
        assert_eq!(
            state
                .resolve_provider_access_grant_record(&grant)
                .await
                .expect("create grant"),
            ProviderAccessGrantResolveOutcome::Created(grant.clone())
        );
        let reference = identity.reference();
        let mut connection = ProviderConnectionRecord {
            connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
            local_actor_id: reference.actor_id.clone(),
            local_tenant_id: reference.tenant_id.clone().expect("tenant"),
            local_space_id: reference.space_id.clone().expect("space"),
            provider_id: "agent-platform".to_string(),
            protocol_version: "3.0.0".to_string(),
            credential_id: grant.grant_id.clone(),
            credential_revision: grant.revision,
            record_hash: String::new(),
            created_at: 150,
        };
        connection.record_hash = connection.canonical_hash();
        assert_eq!(
            state
                .resolve_provider_connection_record(&connection)
                .await
                .expect("create connection"),
            ProviderConnectionResolveOutcome::Created(connection.clone())
        );
        Self {
            _home: home,
            state,
            ready,
            identity,
            grant,
            connection,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct FixedClock;

impl ProviderConnectionClock for FixedClock {
    fn now(&self) -> i64 {
        150
    }
}

#[derive(Clone)]
pub(super) struct RecordingCatalogFactory {
    catalog: RecordingCatalog,
}

impl RecordingCatalogFactory {
    pub(super) fn new(catalog: RecordingCatalog) -> Self {
        Self { catalog }
    }
}

impl ProviderResourceCatalogFactory for RecordingCatalogFactory {
    type Catalog = RecordingCatalog;

    async fn connect_catalog(
        &self,
        _request: ProviderDescriptorReadRequest,
    ) -> Result<Self::Catalog, ProviderDescriptorReadError> {
        Ok(self.catalog.clone())
    }
}

#[derive(Clone)]
pub(super) struct RecordingCatalog {
    descriptor: LiveProviderDescriptor,
    page: ResourcePage,
    manifest: ResourceManifest,
    state: Arc<Mutex<RecordingCatalogState>>,
}

impl RecordingCatalog {
    pub(super) fn new(
        descriptor: LiveProviderDescriptor,
        page: ResourcePage,
        manifest: ResourceManifest,
        action: CatalogAction,
    ) -> Self {
        Self {
            descriptor,
            page,
            manifest,
            state: Arc::new(Mutex::new(RecordingCatalogState {
                action: Some(action),
            })),
        }
    }
}

impl ProviderResourceCatalog for RecordingCatalog {
    fn descriptor(&self) -> &LiveProviderDescriptor {
        &self.descriptor
    }

    async fn list_resources(
        &self,
        _query: ResourceListQuery,
    ) -> Result<ResourcePage, ProviderError> {
        let action = self.state.lock().await.action.take();
        run_action(action).await?;
        Ok(self.page.clone())
    }

    async fn read_manifest(
        &self,
        _resource: ResourceRef,
    ) -> Result<ResourceManifest, ProviderError> {
        let action = self.state.lock().await.action.take();
        run_action(action).await?;
        Ok(self.manifest.clone())
    }
}

struct RecordingCatalogState {
    action: Option<CatalogAction>,
}

pub(super) enum CatalogAction {
    Noop,
    Revoke {
        state: Arc<crewon_state::StateRuntime>,
        request: ProviderAccessGrantRevokeRequest,
    },
}

async fn run_action(action: Option<CatalogAction>) -> Result<(), ProviderError> {
    match action {
        Some(CatalogAction::Noop) | None => {}
        Some(CatalogAction::Revoke { state, request }) => {
            let outcome = state
                .revoke_provider_access_grant_record(&request)
                .await
                .map_err(|_| ProviderError::Unavailable)?;
            if outcome != ProviderAccessGrantRevokeOutcome::Revoked {
                return Err(ProviderError::Unavailable);
            }
        }
    }
    Ok(())
}

pub(super) fn descriptor(protocol_version: &str) -> LiveProviderDescriptor {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new(protocol_version).expect("protocol"),
    };
    let capabilities = ProviderCapabilities::new(
        provider.clone(),
        [Capability {
            resource_kind: ResourceKind::Agent,
            binding_mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
        }],
    )
    .expect("capabilities");
    LiveProviderDescriptor::new_agent_platform(
        provider,
        [crewon_provider_agent_platform::AgentPlatformCapability::DurableRun],
        capabilities,
    )
    .expect("descriptor")
}

pub(super) fn resource_ref() -> ResourceRef {
    ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new("agent-platform").expect("provider id"),
            protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
        },
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new("agent-demo").expect("resource id"),
        revision: ResourceRevision::new("agent-version:7").expect("revision"),
    }
}

pub(super) fn resource_manifest(resource: ResourceRef) -> ResourceManifest {
    ResourceManifest {
        resource,
        schema_version: ManifestSchemaVersion::new("agent.manifest.v1").expect("schema"),
        content_digest: Some(
            ContentDigest::new(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .expect("digest"),
        ),
    }
}
