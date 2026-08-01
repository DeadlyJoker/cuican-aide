use std::sync::Mutex;

use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use serde_json::Value;

use super::provider_identity_refresh::apply_provider_identity_source_snapshot;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSettings;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSupervisor;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSupervisorError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadRequest;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReader;

const CANONICAL: &str =
    include_str!("../../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");

struct FixedReader {
    snapshot: Option<ProviderIdentitySourceSnapshot>,
    requests: Mutex<Vec<ProviderIdentitySourceReadRequest>>,
}

impl ProviderIdentitySourceReader for FixedReader {
    async fn read(
        &self,
        request: ProviderIdentitySourceReadRequest,
        _now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, ProviderIdentitySourceReadError> {
        self.requests.lock().expect("request lock").push(request);
        self.snapshot.clone().ok_or(ProviderIdentitySourceReadError)
    }
}

#[tokio::test]
async fn restart_supervisor_refreshes_every_bounded_mapping_before_returning_ready_token() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let initial = snapshot(
        /*issued_at*/ 1_785_000_060,
        /*fresh_until*/ 1_785_000_120,
        /*now*/ 1_785_000_061,
    );
    apply_provider_identity_source_snapshot(&state, &owner(), &initial)
        .await
        .expect("create initial mapping");
    let later = snapshot(
        /*issued_at*/ 1_785_000_100,
        /*fresh_until*/ 1_785_000_160,
        /*now*/ 1_785_000_101,
    );
    let reader = FixedReader {
        snapshot: Some(later),
        requests: Mutex::new(Vec::new()),
    };

    let ready = ProviderIdentityRefreshSupervisor::new(
        &state,
        &reader,
        ProviderIdentityRefreshSettings::new(/*page_size*/ 1, /*max_bindings*/ 10)
            .expect("settings"),
    )
    .refresh_all(/*now*/ 1_785_000_101)
    .await
    .expect("refresh all");

    assert_eq!(ready.refreshed_bindings(), 1);
    assert_eq!(ready.completed_at(), 1_785_000_101);
    {
        let requests = reader.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].source_binding_id,
            initial.binding().source_binding_id()
        );
        assert_eq!(requests[0].expected_owner, owner());
    }
    let current = state
        .get_active_provider_identity_binding_record(&owner(), /*now*/ 1_785_000_150)
        .await
        .expect("fresh lookup")
        .expect("fresh mapping");
    assert_eq!(current.revision, 2);
    state.close().await;
}

#[tokio::test]
async fn restart_supervisor_returns_no_ready_token_when_source_is_unavailable() {
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    let initial = snapshot(
        /*issued_at*/ 1_785_000_060,
        /*fresh_until*/ 1_785_000_120,
        /*now*/ 1_785_000_061,
    );
    apply_provider_identity_source_snapshot(&state, &owner(), &initial)
        .await
        .expect("create initial mapping");
    let reader = FixedReader {
        snapshot: None,
        requests: Mutex::new(Vec::new()),
    };

    assert_eq!(
        ProviderIdentityRefreshSupervisor::new(
            &state,
            &reader,
            ProviderIdentityRefreshSettings::new(/*page_size*/ 10, /*max_bindings*/ 10)
                .expect("settings"),
        )
        .refresh_all(/*now*/ 1_785_000_101)
        .await
        .expect_err("source failure blocks readiness"),
        ProviderIdentityRefreshSupervisorError::SourceUnavailable
    );
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

fn snapshot(issued_at: i64, fresh_until: i64, now: i64) -> ProviderIdentitySourceSnapshot {
    let mut wire: Value = serde_json::from_str(CANONICAL).expect("canonical JSON");
    wire["freshness"]["issuedAt"] = issued_at.into();
    wire["freshness"]["freshUntil"] = fresh_until.into();
    ProviderIdentitySourceSnapshot::parse(&serde_json::to_vec(&wire).expect("snapshot JSON"), now)
        .expect("snapshot")
}

async fn initialized(home: &tempfile::TempDir) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}
