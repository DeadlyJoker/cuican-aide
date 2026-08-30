use crewon_provider_agent_platform::ProviderIdentitySourceOwner;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderAccessGrantLookup;
use crewon_state::ProviderAccessGrantOwnerLookup;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;

use super::provider_access_grant_provisioner::ProviderAccessGrantProvisionError;
use super::provider_access_grant_provisioner::provision_agent_platform_access_grant;
use super::provider_access_grant_scope::agent_platform_scopes;

const IDENTITY_SOURCE_FIXTURE: &str =
    include_str!("../../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");

#[tokio::test]
async fn provisions_one_secret_free_provider_grant_idempotently() {
    let fixture = Fixture::new().await;
    let first = provision_agent_platform_access_grant(
        &fixture.state,
        &fixture.owner,
        &fixture.snapshot,
        /*expires_at*/ 1_785_000_300,
        /*now*/ 1_785_000_061,
    )
    .await
    .expect("provision grant");
    let replay = provision_agent_platform_access_grant(
        &fixture.state,
        &fixture.owner,
        &fixture.snapshot,
        /*expires_at*/ 1_785_000_300,
        /*now*/ 1_785_000_062,
    )
    .await
    .expect("replay grant");

    assert_eq!(replay, first);
    assert_eq!(first.granted_scopes, agent_platform_scopes());
    assert_eq!(
        fixture
            .state
            .get_active_provider_access_grant_record(
                &ProviderAccessGrantLookup {
                    local_actor_id: fixture.owner.actor_id().to_string(),
                    local_tenant_id: fixture.owner.tenant_id().to_string(),
                    local_space_id: fixture.owner.space_id().to_string(),
                    provider_id: "agent-platform".to_string(),
                    source_binding_id: fixture.snapshot.binding().source_binding_id().to_string(),
                    source_revision: fixture.snapshot.binding().source_revision(),
                },
                /*now*/ 1_785_000_062,
            )
            .await
            .expect("read active grant"),
        Some(first)
    );
    fixture.close().await;
}

#[tokio::test]
async fn changed_session_expiry_refreshes_grant_without_rotating_authority() {
    let fixture = Fixture::new().await;
    let first = provision_agent_platform_access_grant(
        &fixture.state,
        &fixture.owner,
        &fixture.snapshot,
        /*expires_at*/ 1_785_000_200,
        /*now*/ 1_785_000_061,
    )
    .await
    .expect("provision first grant");
    let refreshed = provision_agent_platform_access_grant(
        &fixture.state,
        &fixture.owner,
        &fixture.snapshot,
        /*expires_at*/ 1_785_000_300,
        /*now*/ 1_785_000_100,
    )
    .await
    .expect("refresh grant");

    let mut expected = first.clone();
    expected.expires_at = 1_785_000_300;
    expected.record_hash = expected.canonical_hash();
    assert_eq!(refreshed, expected);
    assert_eq!(
        fixture
            .state
            .get_provider_access_grant_record(&first.grant_id)
            .await
            .expect("read refreshed grant"),
        Some(expected.clone())
    );
    assert_eq!(
        fixture
            .state
            .get_current_provider_access_grant_record(&owner_lookup(&fixture))
            .await
            .expect("read current grant"),
        Some(expected)
    );
    fixture.close().await;
}

#[tokio::test]
async fn expired_grant_still_rotates_without_widening_scopes() {
    let fixture = Fixture::new().await;
    let first = provision_agent_platform_access_grant(
        &fixture.state,
        &fixture.owner,
        &fixture.snapshot,
        /*expires_at*/ 1_785_000_200,
        /*now*/ 1_785_000_061,
    )
    .await
    .expect("provision first grant");
    let replacement = provision_agent_platform_access_grant(
        &fixture.state,
        &fixture.owner,
        &fixture.snapshot,
        /*expires_at*/ 1_785_000_300,
        /*now*/ 1_785_000_201,
    )
    .await
    .expect("replace expired grant");

    assert_ne!(replacement.grant_id, first.grant_id);
    assert_eq!(replacement.granted_scopes, first.granted_scopes);
    let mut expected_revoked = first;
    expected_revoked.status = ProviderAccessGrantStatus::Revoked;
    expected_revoked.revision = 2;
    expected_revoked.updated_at = 1_785_000_201;
    expected_revoked.revoked_at = Some(1_785_000_201);
    expected_revoked.record_hash = expected_revoked.canonical_hash();
    assert_eq!(
        fixture
            .state
            .get_provider_access_grant_record(&expected_revoked.grant_id)
            .await
            .expect("read expired grant"),
        Some(expected_revoked)
    );
    fixture.close().await;
}

#[tokio::test]
async fn owner_drift_and_concurrent_provisioning_fail_closed_or_converge() {
    let fixture = Fixture::new().await;
    let wrong_owner =
        ProviderIdentitySourceOwner::new(fixture.owner.actor_id(), fixture.owner.tenant_id(), "12")
            .expect("wrong owner");
    assert_eq!(
        provision_agent_platform_access_grant(
            &fixture.state,
            &wrong_owner,
            &fixture.snapshot,
            /*expires_at*/ 1_785_000_300,
            /*now*/ 1_785_000_061,
        )
        .await
        .expect_err("owner drift rejected"),
        ProviderAccessGrantProvisionError::Conflict
    );

    let (first, second) = tokio::join!(
        provision_agent_platform_access_grant(
            &fixture.state,
            &fixture.owner,
            &fixture.snapshot,
            /*expires_at*/ 1_785_000_300,
            /*now*/ 1_785_000_061,
        ),
        provision_agent_platform_access_grant(
            &fixture.state,
            &fixture.owner,
            &fixture.snapshot,
            /*expires_at*/ 1_785_000_300,
            /*now*/ 1_785_000_061,
        )
    );
    assert_eq!(
        first.expect("first provision"),
        second.expect("second provision")
    );
    fixture.close().await;
}

struct Fixture {
    home: tempfile::TempDir,
    state: std::sync::Arc<StateRuntime>,
    owner: ProviderIdentitySourceOwner,
    snapshot: ProviderIdentitySourceSnapshot,
}

impl Fixture {
    async fn new() -> Self {
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
        Self {
            home,
            state,
            owner,
            snapshot,
        }
    }

    async fn close(self) {
        self.state.close().await;
        drop(self.home);
    }
}

fn owner_lookup(fixture: &Fixture) -> ProviderAccessGrantOwnerLookup {
    ProviderAccessGrantOwnerLookup {
        local_actor_id: fixture.owner.actor_id().to_string(),
        local_tenant_id: fixture.owner.tenant_id().to_string(),
        local_space_id: fixture.owner.space_id().to_string(),
        provider_id: "agent-platform".to_string(),
    }
}
