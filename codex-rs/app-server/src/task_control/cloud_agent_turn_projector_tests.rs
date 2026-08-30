use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crewon_provider_agent_platform::ProviderArtifactMediaType;
use crewon_provider_agent_platform::ProviderArtifactSensitivity;
use crewon_provider_agent_platform::ProviderRunArtifactContent;
use crewon_provider_agent_platform::ProviderRunAuthorizationBinding;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_state::CloudAgentTurnFinalizationStatus;
use crewon_state::CloudAgentTurnStatus;
use crewon_state::ProviderRunEventProjection;
use crewon_state::ProviderRunFailureCode;
use crewon_state::ProviderRunOutputArtifactKind;
use crewon_state::ProviderRunOutputArtifactRef;
use crewon_state::ProviderRunOutputArtifactRetention;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use sha2::Digest;
use sha2::Sha256;

use super::super::cloud_agent_result_reader::CloudAgentResultArtifactReadError;
use super::super::cloud_agent_result_reader::CloudAgentResultArtifactReadRequest;
use super::super::cloud_agent_result_reader::CloudAgentResultArtifactReader;
use super::super::cloud_agent_task_authority::CloudAgentTaskAuthority;
use super::super::cloud_agent_turn_cancellation::CloudAgentTurnInterruptRequest;
use super::super::cloud_agent_turn_cancellation::interrupt_cloud_agent_turn;
use super::super::cloud_agent_turn_coordinator::tests::fixture;
use super::super::cloud_agent_turn_coordinator::tests::start;
use super::super::cloud_agent_turn_projector_test_support::ProjectorHarness;
use super::super::cloud_agent_turn_projector_test_support::projector_harness;
use super::super::provider_run_artifact_importer::ProviderRunOutputArtifactImportError;
use super::super::provider_run_artifact_importer::ProviderRunOutputArtifactImportRequest;
use super::super::provider_run_artifact_importer::ProviderRunOutputArtifactImportResult;
use super::super::provider_run_artifact_importer::ProviderRunOutputArtifactImporter;
use super::super::provider_run_artifact_importer::StateProviderRunOutputArtifactImporter;
use super::CloudAgentTurnProjector;
use super::CloudAgentTurnProjectorReport;
use super::CloudAgentTurnTerminalNotice;

const BODY: &[u8] = b"verified cloud agent result";

pub(crate) async fn completed_turn_harness() -> ProjectorHarness {
    let harness = projector_harness(vec![completed_projection()]).await;
    let projector = CloudAgentTurnProjector::new(
        harness.fixture.state.clone(),
        Arc::new(FakeReader::success()),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            harness.fixture.state.clone(),
        )),
    );
    let report = projector
        .run_once(/*now*/ 200)
        .await
        .expect("complete projected Turn");
    assert_eq!(report.completed, 1);
    harness
}

#[tokio::test]
async fn queued_task_cancellation_projects_terminal_turn_once_across_restart() {
    let harness_fixture = fixture().await;
    let turn = start(
        &harness_fixture.state,
        &harness_fixture.identity,
        "client-message-projector-cancel",
        "Cancel before Provider dispatch",
        /*now*/ 150,
    )
    .await
    .expect("create queued Cloud Agent Turn")
    .turn;
    interrupt_cloud_agent_turn(CloudAgentTurnInterruptRequest {
        state: harness_fixture.state.clone(),
        identity: &harness_fixture.identity,
        thread_id: &turn.thread_id,
        turn_id: &turn.turn_id,
        now: 160,
    })
    .await
    .expect("cancel queued Cloud Agent Turn")
    .expect("Cloud Agent cancellation route");
    let (notification_tx, mut notification_rx) = tokio::sync::mpsc::channel(4);
    let projector = CloudAgentTurnProjector::new(
        harness_fixture.state.clone(),
        Arc::new(FakeReader::success()),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            harness_fixture.state.clone(),
        )),
    )
    .with_notification_sender(notification_tx);

    assert_eq!(
        projector
            .run_once(/*now*/ 170)
            .await
            .expect("project queued cancellation"),
        CloudAgentTurnProjectorReport {
            inspected: 1,
            projected: 1,
            ..CloudAgentTurnProjectorReport::default()
        }
    );
    let cancelled = harness_fixture
        .state
        .get_cloud_agent_turn_record(&turn.turn_id)
        .await
        .expect("read cancelled Turn")
        .expect("cancelled Turn exists");
    assert_eq!(cancelled.status, CloudAgentTurnStatus::Cancelled);
    assert_eq!(cancelled.last_provider_sequence, 0);
    assert_eq!(
        notification_rx.recv().await,
        Some(CloudAgentTurnTerminalNotice {
            thread_id: cancelled.thread_id.clone(),
            turn_id: cancelled.turn_id.clone(),
            revision: cancelled.revision,
        })
    );

    drop(projector);
    harness_fixture.state.close().await;
    let restarted = StateRuntime::init(
        harness_fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let (notification_tx, mut notification_rx) = tokio::sync::mpsc::channel(4);
    let restarted_projector = CloudAgentTurnProjector::new(
        restarted.clone(),
        Arc::new(FakeReader::success()),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            restarted.clone(),
        )),
    )
    .with_notification_sender(notification_tx);
    assert_eq!(
        restarted_projector
            .run_once(/*now*/ 180)
            .await
            .expect("repeat cancellation projection after restart"),
        CloudAgentTurnProjectorReport::default()
    );
    assert!(notification_rx.try_recv().is_err());
    assert_eq!(
        restarted
            .get_cloud_agent_turn_record(&turn.turn_id)
            .await
            .expect("read restarted cancelled Turn"),
        Some(cancelled)
    );
    restarted.close().await;
}

#[tokio::test]
async fn terminal_notice_is_metadata_only_and_emitted_once_after_durable_commit() {
    let harness = projector_harness(vec![completed_projection()]).await;
    let (notification_tx, mut notification_rx) = tokio::sync::mpsc::channel(4);
    let projector = CloudAgentTurnProjector::new(
        harness.fixture.state.clone(),
        Arc::new(FakeReader::success()),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            harness.fixture.state.clone(),
        )),
    )
    .with_notification_sender(notification_tx);

    let report = projector
        .run_once(/*now*/ 200)
        .await
        .expect("complete projected Turn");
    assert_eq!(report.completed, 1);
    let completed = harness
        .fixture
        .state
        .get_cloud_agent_turn_record(&harness.turn.turn_id)
        .await
        .expect("read completed Turn")
        .expect("completed Turn exists");
    assert_eq!(
        notification_rx.recv().await,
        Some(CloudAgentTurnTerminalNotice {
            thread_id: completed.thread_id,
            turn_id: completed.turn_id,
            revision: completed.revision,
        })
    );
    assert_eq!(
        projector
            .run_once(/*now*/ 201)
            .await
            .expect("repeat projected Turn"),
        CloudAgentTurnProjectorReport::default()
    );
    assert!(notification_rx.try_recv().is_err());
    harness.fixture.state.close().await;
}

#[tokio::test]
async fn progress_and_completed_projection_are_restart_safe_and_exactly_once() {
    let harness = projector_harness(vec![
        ProviderRunEventProjection::RunStarted { revision: 1 },
        ProviderRunEventProjection::Progress {
            summary: "Working".to_string(),
        },
        completed_projection(),
    ])
    .await;
    let reader = Arc::new(FakeReader::success());
    let importer = Arc::new(StateProviderRunOutputArtifactImporter::new(
        harness.fixture.state.clone(),
    ));
    let projector =
        CloudAgentTurnProjector::new(harness.fixture.state.clone(), reader.clone(), importer);

    assert_eq!(
        projector.run_once(/*now*/ 200).await.expect("project Turn"),
        CloudAgentTurnProjectorReport {
            inspected: 1,
            projected: 2,
            finalizing: 1,
            completed: 1,
            ..CloudAgentTurnProjectorReport::default()
        }
    );
    assert_eq!(reader.calls(), 1);
    let completed = harness
        .fixture
        .state
        .get_cloud_agent_turn_record(&harness.turn.turn_id)
        .await
        .expect("read completed Turn")
        .expect("Turn exists");
    assert_eq!(completed.status, CloudAgentTurnStatus::Completed);
    assert_eq!(completed.last_provider_sequence, 3);
    let primary = completed
        .primary_output_artifact
        .as_ref()
        .expect("primary output");
    let stored = harness
        .fixture
        .state
        .get_artifact_record(&primary.artifact_id, primary.revision)
        .await
        .expect("read imported Artifact")
        .expect("Artifact exists");
    assert_eq!(stored.payload.content.as_deref(), Some(BODY));

    drop(projector);
    harness.fixture.state.close().await;
    let restarted = StateRuntime::init(
        harness.fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let restarted_reader = Arc::new(FakeReader::success());
    let restarted_projector = CloudAgentTurnProjector::new(
        restarted.clone(),
        restarted_reader.clone(),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            restarted.clone(),
        )),
    );
    assert_eq!(
        restarted_projector
            .run_once(/*now*/ 210)
            .await
            .expect("restart projector"),
        CloudAgentTurnProjectorReport::default()
    );
    assert_eq!(restarted_reader.calls(), 0);
    restarted.close().await;
}

#[tokio::test]
async fn import_commit_then_failure_remains_finalizing_and_recovers_after_restart() {
    let harness = projector_harness(vec![completed_projection()]).await;
    let reader = Arc::new(FakeReader::success());
    let importer = Arc::new(CommitThenFailOnceImporter {
        inner: StateProviderRunOutputArtifactImporter::new(harness.fixture.state.clone()),
        fail_after_commit: AtomicBool::new(true),
    });
    let projector = CloudAgentTurnProjector::new(harness.fixture.state.clone(), reader, importer);

    assert_eq!(
        projector
            .run_once(/*now*/ 200)
            .await
            .expect("first finalization attempt"),
        CloudAgentTurnProjectorReport {
            inspected: 1,
            finalizing: 1,
            deferred: 1,
            ..CloudAgentTurnProjectorReport::default()
        }
    );
    let pending = harness
        .fixture
        .state
        .get_cloud_agent_turn_finalization_record(&harness.turn.turn_id)
        .await
        .expect("read pending finalization")
        .expect("finalization exists");
    assert_eq!(pending.status, CloudAgentTurnFinalizationStatus::Pending);
    assert_eq!(pending.attempts, 1);
    assert_eq!(pending.available_at, 201);
    assert_eq!(
        harness
            .fixture
            .state
            .get_cloud_agent_turn_record(&harness.turn.turn_id)
            .await
            .expect("read finalizing Turn")
            .expect("Turn exists")
            .status,
        CloudAgentTurnStatus::Finalizing
    );

    drop(projector);
    harness.fixture.state.close().await;
    let restarted = StateRuntime::init(
        harness.fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let projector = CloudAgentTurnProjector::new(
        restarted.clone(),
        Arc::new(FakeReader::success()),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            restarted.clone(),
        )),
    );
    assert_eq!(
        projector
            .run_once(/*now*/ 201)
            .await
            .expect("recover finalization"),
        CloudAgentTurnProjectorReport {
            inspected: 1,
            completed: 1,
            ..CloudAgentTurnProjectorReport::default()
        }
    );
    let completed = restarted
        .get_cloud_agent_turn_record(&harness.turn.turn_id)
        .await
        .expect("read recovered Turn")
        .expect("Turn exists");
    assert_eq!(completed.status, CloudAgentTurnStatus::Completed);
    assert!(completed.primary_output_artifact.is_some());
    let finalization = restarted
        .get_cloud_agent_turn_finalization_record(&harness.turn.turn_id)
        .await
        .expect("read completed finalization")
        .expect("finalization exists");
    assert_eq!(
        finalization.status,
        CloudAgentTurnFinalizationStatus::Completed
    );
    assert_eq!(finalization.attempts, 1);
    restarted.close().await;
}

#[tokio::test]
async fn permanent_result_failure_never_emits_empty_completed_turn() {
    let harness = projector_harness(vec![completed_projection()]).await;
    let projector = CloudAgentTurnProjector::new(
        harness.fixture.state.clone(),
        Arc::new(FakeReader::permanently_unavailable()),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            harness.fixture.state.clone(),
        )),
    );

    assert_eq!(
        projector
            .run_once(/*now*/ 200)
            .await
            .expect("project unavailable result"),
        CloudAgentTurnProjectorReport {
            inspected: 1,
            finalizing: 1,
            result_unavailable: 1,
            ..CloudAgentTurnProjectorReport::default()
        }
    );
    let unavailable = harness
        .fixture
        .state
        .get_cloud_agent_turn_record(&harness.turn.turn_id)
        .await
        .expect("read unavailable Turn")
        .expect("Turn exists");
    assert_eq!(unavailable.status, CloudAgentTurnStatus::ResultUnavailable);
    assert_eq!(unavailable.error_code.as_deref(), Some("resultUnavailable"));
    assert!(unavailable.primary_output_artifact.is_none());
    assert!(unavailable.additional_output_artifacts.is_empty());
    harness.fixture.state.close().await;
}

#[tokio::test]
async fn terminal_failure_waits_for_single_authority_before_releasing_the_thread() {
    let harness = projector_harness(vec![ProviderRunEventProjection::Failed {
        code: ProviderRunFailureCode::Internal,
        retryable: false,
        provider_run_id: "provider-run-projector".to_string(),
        trace_id: "provider-trace-1".to_string(),
    }])
    .await;
    let projector = CloudAgentTurnProjector::new(
        harness.fixture.state.clone(),
        Arc::new(FakeReader::success()),
        Arc::new(StateProviderRunOutputArtifactImporter::new(
            harness.fixture.state.clone(),
        )),
    );

    assert_eq!(
        projector
            .run_once(/*now*/ 170)
            .await
            .expect("defer terminal Turn projection"),
        CloudAgentTurnProjectorReport {
            inspected: 1,
            conflicts: 1,
            ..CloudAgentTurnProjectorReport::default()
        }
    );
    assert_eq!(
        harness
            .fixture
            .state
            .get_cloud_agent_turn_record(&harness.turn.turn_id)
            .await
            .expect("read deferred Turn")
            .expect("Turn exists")
            .status,
        CloudAgentTurnStatus::Queued
    );
    CloudAgentTaskAuthority::new(harness.fixture.state.clone())
        .run_once(/*now*/ 180)
        .await
        .expect("finalize failed Task");
    assert_eq!(
        projector
            .run_once(/*now*/ 181)
            .await
            .expect("project terminal failure"),
        CloudAgentTurnProjectorReport {
            inspected: 1,
            projected: 1,
            ..CloudAgentTurnProjectorReport::default()
        }
    );
    let failed = harness
        .fixture
        .state
        .get_cloud_agent_turn_record(&harness.turn.turn_id)
        .await
        .expect("read failed Turn")
        .expect("Turn exists");
    assert_eq!(failed.status, CloudAgentTurnStatus::Failed);
    assert_eq!(failed.error_code.as_deref(), Some("internal"));
    assert_eq!(failed.trace_id.as_deref(), Some("provider-trace-1"));
    harness.fixture.state.close().await;
}

fn completed_projection() -> ProviderRunEventProjection {
    ProviderRunEventProjection::Completed {
        output_artifacts: vec![ProviderRunOutputArtifactRef {
            artifact_id: "provider-output-1".to_string(),
            task_id: "cloud-agent-task-placeholder".to_string(),
            kind: ProviderRunOutputArtifactKind::Report,
            revision: 1,
            retention: ProviderRunOutputArtifactRetention::Task,
            created_at: 160,
        }],
    }
}

#[derive(Clone, Copy)]
enum FakeReaderMode {
    Success,
    PermanentlyUnavailable,
}

struct FakeReader {
    mode: FakeReaderMode,
    calls: AtomicUsize,
}

impl FakeReader {
    fn success() -> Self {
        Self {
            mode: FakeReaderMode::Success,
            calls: AtomicUsize::new(0),
        }
    }

    fn permanently_unavailable() -> Self {
        Self {
            mode: FakeReaderMode::PermanentlyUnavailable,
            calls: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl CloudAgentResultArtifactReader for FakeReader {
    async fn read(
        &self,
        request: CloudAgentResultArtifactReadRequest,
    ) -> Result<ProviderRunArtifactContent, CloudAgentResultArtifactReadError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if matches!(self.mode, FakeReaderMode::PermanentlyUnavailable) {
            return Err(CloudAgentResultArtifactReadError::PermanentlyUnavailable);
        }
        let authorization = ProviderRunAuthorizationBinding::new(
            agent_resource(),
            &request.journal.key.task_id,
            &request.journal.credential_id,
            request.journal.credential_revision,
        )
        .expect("Provider authorization");
        ProviderRunArtifactContent::new(
            authorization,
            request.artifact,
            ProviderArtifactMediaType::TextMarkdown,
            ProviderArtifactSensitivity::WorkspaceSensitive,
            format!("sha256:{:x}", Sha256::digest(BODY)),
            BODY.to_vec(),
        )
        .map_err(|_| CloudAgentResultArtifactReadError::InvalidCorrelation)
    }
}

struct CommitThenFailOnceImporter {
    inner: StateProviderRunOutputArtifactImporter,
    fail_after_commit: AtomicBool,
}

impl ProviderRunOutputArtifactImporter for CommitThenFailOnceImporter {
    async fn import(
        &self,
        request: ProviderRunOutputArtifactImportRequest,
    ) -> Result<ProviderRunOutputArtifactImportResult, ProviderRunOutputArtifactImportError> {
        let result = self.inner.import(request).await?;
        if self.fail_after_commit.swap(false, Ordering::SeqCst) {
            Err(ProviderRunOutputArtifactImportError::StateUnavailable)
        } else {
            Ok(result)
        }
    }
}

fn agent_resource() -> ResourceRef {
    ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new("agent-platform").expect("Provider ID"),
            protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol version"),
        },
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new("agent-1").expect("Resource ID"),
        revision: ResourceRevision::new("agent-revision-1").expect("Resource revision"),
    }
}
