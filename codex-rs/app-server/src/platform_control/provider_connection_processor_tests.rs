use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crewon_provider_agent_platform::AgentPlatformCapability;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceKind;
use crewon_state::ProviderAccessGrantRefreshOutcome;
use crewon_state::ProviderAccessGrantRefreshRequest;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantRevokeOutcome;
use crewon_state::ProviderAccessGrantRevokeRequest;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use pretty_assertions::assert_eq;
use tokio::sync::Mutex;

use super::provider_access_grant_authority_tests::discovery_grant;
use super::provider_access_grant_authority_tests::initialized;
use super::provider_connection_descriptor::LiveProviderDescriptor;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_descriptor::ProviderDescriptorReadError;
use super::provider_connection_descriptor::ProviderDescriptorReadRequest;
use super::provider_connection_descriptor::ProviderDescriptorReader;
use super::provider_connection_processor::ProviderConnectionProcessor;
use super::provider_connection_processor::ProviderConnectionProcessorError;
use super::provider_identity_adapter_tests::authenticated_identity;
use super::provider_identity_adapter_tests::authenticated_identity_in_space;
use super::provider_identity_adapter_tests::binding;
use super::provider_identity_adapter_tests::ready_mappings;

#[tokio::test]
async fn connect_replays_and_read_survives_state_restart_without_client_credential_selection() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("provider-connect");
    let identity_binding = binding(&identity);
    assert_eq!(
        state
            .create_provider_identity_binding_record(&identity_binding)
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
    let reader = FakeDescriptorReader::stable(descriptor("3.0.0"));
    let clock = FixedClock(150);
    let processor = ProviderConnectionProcessor::new(&state, &ready, &reader, &clock);

    let first = processor
        .connect(&identity, "agent-platform")
        .await
        .expect("connect Provider");
    let replay = processor
        .connect(&identity, "agent-platform")
        .await
        .expect("replay connect");
    assert_eq!(replay, first);
    assert_eq!(first.connection().credential_id, grant.grant_id);
    assert_eq!(first.connection().credential_revision, grant.revision);
    assert_eq!(
        first.descriptor().provider().protocol_version.as_str(),
        "3.0.0"
    );
    assert_eq!(reader.read_count(), 2);
    let refresh_request = ProviderAccessGrantRefreshRequest {
        grant_id: grant.grant_id.clone(),
        expected_revision: grant.revision,
        expected_expires_at: grant.expires_at,
        refreshed_expires_at: 240,
        refreshed_at: 150,
    };
    let mut refreshed_grant = grant.clone();
    refreshed_grant.expires_at = refresh_request.refreshed_expires_at;
    refreshed_grant.record_hash = refreshed_grant.canonical_hash();
    assert_eq!(
        state
            .refresh_provider_access_grant_record(&refresh_request)
            .await
            .expect("refresh grant"),
        ProviderAccessGrantRefreshOutcome::Refreshed(refreshed_grant)
    );
    let after_refresh = processor
        .connect(&identity, "agent-platform")
        .await
        .expect("connect after grant refresh");
    assert_eq!(after_refresh.connection(), first.connection());
    let old_connection = processor
        .read(&identity, &first.connection().connection_id)
        .await
        .expect("old connection remains authorized after grant refresh");
    assert_eq!(old_connection.connection(), first.connection());
    assert_eq!(reader.read_count(), 4);
    let persisted = first.connection().clone();
    state.close().await;

    let reopened = initialized(&home).await;
    let reopened_reader = FakeDescriptorReader::stable(descriptor("3.0.0"));
    let reopened_processor =
        ProviderConnectionProcessor::new(&reopened, &ready, &reopened_reader, &clock);
    let restored = reopened_processor
        .read(&identity, &persisted.connection_id)
        .await
        .expect("read after restart");
    assert_eq!(restored.connection(), &persisted);
    assert_eq!(restored.observed_at(), 150);
    assert_eq!(reopened_reader.read_count(), 1);
    let debug = format!("{restored:?}");
    for sensitive in [
        persisted.local_actor_id.as_str(),
        persisted.credential_id.as_str(),
        grant.source_binding_id.as_str(),
    ] {
        assert!(!debug.contains(sensitive));
    }

    reopened.close().await;
}

#[tokio::test]
async fn read_rejects_cross_owner_and_live_protocol_drift() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("provider-read");
    state
        .create_provider_identity_binding_record(&binding(&identity))
        .await
        .expect("create identity binding");
    let grant = discovery_grant(&identity, /*expires_at*/ 190);
    state
        .resolve_provider_access_grant_record(&grant)
        .await
        .expect("create grant");
    let clock = FixedClock(150);
    let stable_reader = FakeDescriptorReader::stable(descriptor("3.0.0"));
    let stable_processor = ProviderConnectionProcessor::new(&state, &ready, &stable_reader, &clock);
    let connected = stable_processor
        .connect(&identity, "agent-platform")
        .await
        .expect("connect Provider");

    let other_space = authenticated_identity_in_space("provider-read-other", "space-local-2");
    assert_eq!(
        stable_processor
            .read(&other_space, &connected.connection().connection_id)
            .await
            .expect_err("cross-owner read rejected"),
        ProviderConnectionProcessorError::NotFound
    );

    let drift_reader = FakeDescriptorReader::stable(descriptor("3.1.0"));
    let drift_processor = ProviderConnectionProcessor::new(&state, &ready, &drift_reader, &clock);
    assert_eq!(
        drift_processor
            .read(&identity, &connected.connection().connection_id)
            .await
            .expect_err("protocol drift rejected"),
        ProviderConnectionProcessorError::Incompatible
    );

    state.close().await;
}

#[tokio::test]
async fn grant_revoked_during_descriptor_io_fails_closed_before_connection_persistence() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let ready = ready_mappings(&state).await;
    let identity = authenticated_identity("provider-connect-revoke");
    state
        .create_provider_identity_binding_record(&binding(&identity))
        .await
        .expect("create identity binding");
    let grant = discovery_grant(&identity, /*expires_at*/ 190);
    state
        .resolve_provider_access_grant_record(&grant)
        .await
        .expect("create grant");
    let reader = FakeDescriptorReader::revoking(
        descriptor("3.0.0"),
        state.clone(),
        ProviderAccessGrantRevokeRequest {
            grant_id: grant.grant_id.clone(),
            expected_revision: grant.revision,
            revoked_at: 151,
        },
    );
    let clock = FixedClock(150);
    let processor = ProviderConnectionProcessor::new(&state, &ready, &reader, &clock);

    assert_eq!(
        processor
            .connect(&identity, "agent-platform")
            .await
            .expect_err("authority changed during I/O"),
        ProviderConnectionProcessorError::AuthorityChanged
    );
    assert_eq!(reader.read_count(), 1);
    assert_eq!(
        state
            .get_provider_access_grant_record(&grant.grant_id)
            .await
            .expect("read revoked grant")
            .expect("persisted grant")
            .status,
        crewon_state::ProviderAccessGrantStatus::Revoked
    );

    state.close().await;
}

#[derive(Clone, Copy)]
struct FixedClock(i64);

impl ProviderConnectionClock for FixedClock {
    fn now(&self) -> i64 {
        self.0
    }
}

enum ReaderAction {
    Revoke {
        state: Arc<crewon_state::StateRuntime>,
        request: ProviderAccessGrantRevokeRequest,
    },
}

struct FakeDescriptorReader {
    descriptor: LiveProviderDescriptor,
    action: Mutex<Option<ReaderAction>>,
    read_count: AtomicUsize,
}

impl FakeDescriptorReader {
    fn stable(descriptor: LiveProviderDescriptor) -> Self {
        Self {
            descriptor,
            action: Mutex::new(None),
            read_count: AtomicUsize::new(0),
        }
    }

    fn revoking(
        descriptor: LiveProviderDescriptor,
        state: Arc<crewon_state::StateRuntime>,
        request: ProviderAccessGrantRevokeRequest,
    ) -> Self {
        Self {
            descriptor,
            action: Mutex::new(Some(ReaderAction::Revoke { state, request })),
            read_count: AtomicUsize::new(0),
        }
    }

    fn read_count(&self) -> usize {
        self.read_count.load(Ordering::SeqCst)
    }
}

impl ProviderDescriptorReader for FakeDescriptorReader {
    async fn read_descriptor(
        &self,
        _request: ProviderDescriptorReadRequest,
    ) -> Result<LiveProviderDescriptor, ProviderDescriptorReadError> {
        self.read_count.fetch_add(1, Ordering::SeqCst);
        let action = self.action.lock().await.take();
        if let Some(ReaderAction::Revoke { state, request }) = action {
            let outcome = state
                .revoke_provider_access_grant_record(&request)
                .await
                .map_err(|_| ProviderDescriptorReadError::Unavailable)?;
            if outcome != ProviderAccessGrantRevokeOutcome::Revoked {
                return Err(ProviderDescriptorReadError::Unavailable);
            }
        }
        Ok(self.descriptor.clone())
    }
}

fn descriptor(protocol_version: &str) -> LiveProviderDescriptor {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new(protocol_version).expect("protocol"),
    };
    let resource_capabilities = ProviderCapabilities::new(
        provider.clone(),
        [Capability {
            resource_kind: ResourceKind::Agent,
            binding_mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
        }],
    )
    .expect("resource capabilities");
    LiveProviderDescriptor::new_agent_platform(
        provider,
        [AgentPlatformCapability::DurableRun],
        resource_capabilities,
    )
    .expect("live descriptor")
}
