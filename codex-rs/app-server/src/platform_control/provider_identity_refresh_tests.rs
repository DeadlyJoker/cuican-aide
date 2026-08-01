use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::ProviderIdentityBindingStatus;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::provider_identity_refresh::ProviderIdentityRefreshError;
use super::provider_identity_refresh::ProviderIdentityRefreshOutcome;
use super::provider_identity_refresh::apply_provider_identity_source_snapshot;

const CANONICAL: &str =
    include_str!("../../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");
const NOW: i64 = 1_785_000_061;

#[tokio::test]
async fn active_source_snapshot_creates_idempotently_refreshes_and_never_regresses() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let initial =
        ProviderIdentitySourceSnapshot::parse(CANONICAL.as_bytes(), NOW).expect("initial snapshot");

    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &owner(), &initial)
            .await
            .expect("create mapping"),
        ProviderIdentityRefreshOutcome::Created
    );
    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &owner(), &initial)
            .await
            .expect("replay mapping"),
        ProviderIdentityRefreshOutcome::ExistingFresh
    );

    let later = active_snapshot(
        /*issued_at*/ 1_785_000_100,
        /*fresh_until*/ 1_785_000_160,
        /*now*/ 1_785_000_101,
    );
    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &owner(), &later)
            .await
            .expect("refresh mapping"),
        ProviderIdentityRefreshOutcome::Refreshed
    );
    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &owner(), &initial)
            .await
            .expect_err("freshness regression rejected"),
        ProviderIdentityRefreshError::Conflict
    );

    let current = state
        .get_active_provider_identity_binding_record(&owner(), /*now*/ 1_785_000_150)
        .await
        .expect("fresh lookup")
        .expect("fresh mapping");
    assert_eq!(current.revision, 2);
    assert_eq!(current.source_fresh_until, 1_785_000_160);

    let mut wrong_owner = owner();
    wrong_owner.local_space_id = "12".to_string();
    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &wrong_owner, &later)
            .await
            .expect_err("owner mix-up rejected"),
        ProviderIdentityRefreshError::OwnerMismatch
    );
    state.close().await;
}

#[tokio::test]
async fn revoked_source_snapshot_is_terminal_and_active_replay_cannot_resurrect() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let initial =
        ProviderIdentitySourceSnapshot::parse(CANONICAL.as_bytes(), NOW).expect("initial snapshot");
    apply_provider_identity_source_snapshot(&state, &owner(), &initial)
        .await
        .expect("create mapping");

    let revoked = revoked_snapshot();
    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &owner(), &revoked)
            .await
            .expect("revoke mapping"),
        ProviderIdentityRefreshOutcome::Revoked
    );
    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &owner(), &revoked)
            .await
            .expect("replay revoke"),
        ProviderIdentityRefreshOutcome::ExistingRevoked
    );
    assert_eq!(
        apply_provider_identity_source_snapshot(&state, &owner(), &initial)
            .await
            .expect_err("resurrection rejected"),
        ProviderIdentityRefreshError::Conflict
    );

    assert_eq!(
        state
            .get_active_provider_identity_binding_record(&owner(), /*now*/ 1_785_000_101)
            .await
            .expect("active lookup"),
        None
    );
    let stored = state
        .get_provider_identity_binding_record(revoked.binding().source_binding_id())
        .await
        .expect("stored binding")
        .expect("revoked mapping");
    assert_eq!(stored.status, ProviderIdentityBindingStatus::Revoked);
    assert_eq!(stored.source_revision, 2);
    state.close().await;
}

fn owner() -> ProviderIdentityBindingLookup {
    ProviderIdentityBindingLookup {
        local_actor_id:
            "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f".to_string(),
        local_tenant_id: "7".to_string(),
        local_space_id: "11".to_string(),
        provider_id: "agent-platform".to_string(),
    }
}

fn active_snapshot(issued_at: i64, fresh_until: i64, now: i64) -> ProviderIdentitySourceSnapshot {
    let mut wire: Value = serde_json::from_str(CANONICAL).expect("canonical JSON");
    wire["freshness"]["issuedAt"] = issued_at.into();
    wire["freshness"]["freshUntil"] = fresh_until.into();
    ProviderIdentitySourceSnapshot::parse(&serde_json::to_vec(&wire).expect("active JSON"), now)
        .expect("active snapshot")
}

fn revoked_snapshot() -> ProviderIdentitySourceSnapshot {
    let mut wire: Value = serde_json::from_str(CANONICAL).expect("canonical JSON");
    wire["binding"]["sourceRevision"] = 2.into();
    wire["binding"]["status"] = "revoked".into();
    wire["binding"]["updatedAt"] = 1_785_000_090_i64.into();
    wire["freshness"]["issuedAt"] = 1_785_000_100_i64.into();
    wire["freshness"]["freshUntil"] = 1_785_000_160_i64.into();
    wire["binding"]["bindingDigest"] = source_binding_digest(&wire).into();
    ProviderIdentitySourceSnapshot::parse(
        &serde_json::to_vec(&wire).expect("revoked JSON"),
        /*now*/ 1_785_000_101,
    )
    .expect("revoked snapshot")
}

fn source_binding_digest(wire: &Value) -> String {
    let binding = &wire["binding"];
    let local = &binding["localOwner"];
    let provider = &binding["providerIdentity"];
    let parts = [
        "agent-platform-identity".to_string(),
        text(binding, "sourceBindingId"),
        binding["sourceRevision"].to_string(),
        text(binding, "status"),
        text(local, "actorId"),
        text(local, "tenantId"),
        text(local, "spaceId"),
        text(provider, "providerId"),
        text(provider, "subject"),
        text(provider, "tenantId"),
        text(provider, "spaceId"),
        binding["createdAt"].to_string(),
        binding["updatedAt"].to_string(),
    ];
    let mut digest = Sha256::new();
    digest.update(b"crewon.provider-identity-source-binding.v1\0");
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("sha256:{:x}", digest.finalize())
}

fn text(value: &Value, field: &str) -> String {
    value[field].as_str().expect("string field").to_string()
}

async fn initialized(home: &tempfile::TempDir) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}
