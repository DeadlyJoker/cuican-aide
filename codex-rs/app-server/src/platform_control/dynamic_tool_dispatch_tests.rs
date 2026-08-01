use std::future;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crewon_app_server_protocol::DynamicToolCallOutputContentItem;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactRef;
use crewon_artifact::ArtifactRevision;
use pretty_assertions::assert_eq;
use serde_json::json;

use super::dynamic_tool_execution_tests::Harness;
use super::dynamic_tool_router::dispatch::*;
use super::dynamic_tool_router::ports::*;
use super::dynamic_tool_router::registration::DynamicToolOperation;

#[tokio::test]
async fn selected_provider_route_executes_once_and_completes_metadata_only() {
    let provider_harness = Harness::new();
    let artifact = ArtifactRef::new(
        ArtifactId::new("artifact-tool-result").expect("artifact id"),
        ArtifactRevision::new(/*value*/ 7).expect("artifact revision"),
    );
    let provider = FakeProviderExecutor::returns(DynamicToolAdapterOutcome::Succeeded(
        BoundedDynamicToolResult::artifact(artifact.clone()),
    ));
    let provider_dispatcher = dispatcher(
        &provider,
        provider_harness.journal(),
        /*timeout_ms*/ 100,
    );
    let outcome = provider_dispatcher
        .dispatch(
            provider_harness
                .authorized("call-provider", json!({"query": "provider"}))
                .await,
        )
        .await
        .expect("provider dispatch");
    let DynamicToolDispatchOutcome::Succeeded(result) = outcome else {
        panic!("expected provider success");
    };
    assert_eq!(provider.calls(), 1);
    assert_eq!(result.artifact_ref(), Some(&artifact));
    assert!(matches!(
        provider_harness.journal().single_completion().terminal(),
        DynamicToolExecutionTerminal::Succeeded(DynamicToolExecutionResultMetadata::Artifact {
            revision: 7,
            ..
        })
    ));
}

#[tokio::test]
async fn adapter_failure_and_unknown_are_terminal_without_fallback() {
    for (call_id, adapter_outcome, expected_terminal) in [
        (
            "call-failed",
            DynamicToolAdapterOutcome::Failed(DynamicToolExecutionFailure::Rejected),
            DynamicToolExecutionTerminal::Failed(DynamicToolExecutionFailure::Rejected),
        ),
        (
            "call-unknown",
            DynamicToolAdapterOutcome::Unknown(DynamicToolExecutionUnknown::AdapterUnavailable),
            DynamicToolExecutionTerminal::Unknown(DynamicToolExecutionUnknown::AdapterUnavailable),
        ),
    ] {
        let harness = Harness::new();
        let provider = FakeProviderExecutor::returns(adapter_outcome);
        let dispatcher = dispatcher(&provider, harness.journal(), /*timeout_ms*/ 100);
        let outcome = dispatcher
            .dispatch(harness.authorized(call_id, json!({})).await)
            .await
            .expect("terminal outcome");
        assert_eq!(outcome.terminal_status(), expected_terminal);
        assert_eq!(provider.calls(), 1);
        assert_eq!(
            harness.journal().single_completion().terminal(),
            &expected_terminal
        );
    }
}

#[tokio::test]
async fn timeout_is_unknown_and_does_not_retry_or_fallback() {
    let harness = Harness::new();
    let provider = FakeProviderExecutor::pending();
    let dispatcher = dispatcher(&provider, harness.journal(), /*timeout_ms*/ 10);

    let outcome = dispatcher
        .dispatch(harness.authorized("call-timeout", json!({})).await)
        .await
        .expect("persist timeout");
    assert_eq!(
        outcome.terminal_status(),
        DynamicToolExecutionTerminal::Unknown(DynamicToolExecutionUnknown::Timeout)
    );
    assert_eq!(provider.calls(), 1);
    assert_eq!(
        harness.journal().single_completion().terminal(),
        &DynamicToolExecutionTerminal::Unknown(DynamicToolExecutionUnknown::Timeout)
    );
}

#[tokio::test]
async fn completion_failure_after_execution_is_unknown_to_the_caller_without_fallback() {
    let harness = Harness::new();
    harness.journal().fail_completion();
    let provider = FakeProviderExecutor::returns(DynamicToolAdapterOutcome::Succeeded(
        text_result("executed exactly once"),
    ));
    let dispatcher = dispatcher(&provider, harness.journal(), /*timeout_ms*/ 100);

    assert_eq!(
        dispatcher
            .dispatch(
                harness
                    .authorized("call-completion-failed", json!({}))
                    .await
            )
            .await
            .expect_err("completion is required"),
        DynamicToolDispatchError::UnknownOutcome
    );
    assert_eq!(provider.calls(), 1);
    assert!(harness.journal().completions().is_empty());
}

#[tokio::test]
async fn cancellation_leaves_the_durable_claim_for_reconciliation() {
    let harness = Harness::new();
    let provider = FakeProviderExecutor::pending();
    let dispatcher = dispatcher(&provider, harness.journal(), /*timeout_ms*/ 100);
    let mut dispatch =
        Box::pin(dispatcher.dispatch(harness.authorized("call-cancelled", json!({})).await));

    tokio::select! {
        result = &mut dispatch => panic!("pending adapter completed unexpectedly: {result:?}"),
        () = tokio::time::sleep(Duration::from_millis(5)) => {}
    }
    drop(dispatch);

    assert_eq!(provider.calls(), 1);
    assert_eq!(harness.journal().claims().len(), 1);
    assert!(harness.journal().completions().is_empty());
}

#[test]
fn inline_results_are_bounded_and_unsafe_images_require_artifacts() {
    assert_eq!(
        BoundedDynamicToolResult::inline(
            (0..17)
                .map(|index| DynamicToolCallOutputContentItem::InputText {
                    text: format!("item-{index}"),
                })
                .collect(),
        )
        .expect_err("item cap"),
        DynamicToolResultValidationError::TooManyItems
    );
    assert_eq!(
        BoundedDynamicToolResult::inline(vec![DynamicToolCallOutputContentItem::InputText {
            text: "x".repeat(16 * 1024 + 1),
        },])
        .expect_err("item cap"),
        DynamicToolResultValidationError::ItemTooLarge
    );
    assert_eq!(
        BoundedDynamicToolResult::inline(
            (0..3)
                .map(|_| DynamicToolCallOutputContentItem::InputText {
                    text: "x".repeat(12 * 1024),
                })
                .collect(),
        )
        .expect_err("response cap"),
        DynamicToolResultValidationError::ResponseTooLarge
    );
    assert_eq!(
        BoundedDynamicToolResult::inline(vec![DynamicToolCallOutputContentItem::InputImage {
            image_url: "https://provider.invalid/private.png".to_string(),
        },])
        .expect_err("remote image requires artifact"),
        DynamicToolResultValidationError::UnsafeImageReference
    );
    BoundedDynamicToolResult::inline(vec![DynamicToolCallOutputContentItem::InputImage {
        image_url: "data:image/png;base64,iVBORw0KGgo=".to_string(),
    }])
    .expect("bounded raster data URL");
    assert_eq!(
        BoundedDynamicToolResult::inline(vec![DynamicToolCallOutputContentItem::InputImage {
            image_url: "data:image/png;base64,not-base64".to_string(),
        },])
        .expect_err("invalid image data"),
        DynamicToolResultValidationError::InvalidImageData
    );
    assert_eq!(
        BoundedDynamicToolResult::inline(vec![DynamicToolCallOutputContentItem::InputImage {
            image_url: "data:image/png;base64,dGVzdA==".to_string(),
        },])
        .expect_err("image signature mismatch"),
        DynamicToolResultValidationError::InvalidImageData
    );
}

fn dispatcher<'a>(
    provider: &'a FakeProviderExecutor,
    journal: &'a super::dynamic_tool_execution_tests::FakeJournal,
    timeout_ms: u64,
) -> DynamicToolDispatcher<'a, FakeProviderExecutor, super::dynamic_tool_execution_tests::FakeJournal>
{
    DynamicToolDispatcher::new(
        provider,
        journal,
        DynamicToolDispatchConfig::new(Duration::from_millis(timeout_ms)).expect("dispatch config"),
    )
}

fn text_result(text: &str) -> BoundedDynamicToolResult {
    BoundedDynamicToolResult::inline(vec![DynamicToolCallOutputContentItem::InputText {
        text: text.to_string(),
    }])
    .expect("bounded text result")
}

enum FakeExecutorBehavior {
    Return(DynamicToolAdapterOutcome),
    Pending,
}

struct FakeProviderExecutor {
    calls: AtomicUsize,
    behavior: Mutex<Option<FakeExecutorBehavior>>,
}

impl FakeProviderExecutor {
    fn returns(outcome: DynamicToolAdapterOutcome) -> Self {
        Self::new(FakeExecutorBehavior::Return(outcome))
    }

    fn pending() -> Self {
        Self::new(FakeExecutorBehavior::Pending)
    }

    fn new(behavior: FakeExecutorBehavior) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            behavior: Mutex::new(Some(behavior)),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl ProviderDynamicToolExecutor for FakeProviderExecutor {
    async fn execute(
        &self,
        request: ProviderDynamicToolExecutionRequest,
    ) -> DynamicToolAdapterOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(!format!("{request:?}").contains("private arguments"));
        assert!(request.connection_id().starts_with("provider-connection:"));
        assert_eq!(request.resource_id(), "resource-9");
        assert_eq!(request.operation(), DynamicToolOperation::Call);
        assert_eq!(request.credential().revision(), Some(1));
        assert_eq!(request.claim().credential_revision, Some(1));
        assert_eq!(request.claim().tenant_id.as_deref(), Some("tenant-local-1"));
        assert_eq!(request.claim().space_id.as_deref(), Some("space-local-1"));
        assert!(request.claim().thread_id.starts_with("thread-nonce-call-"));
        assert!(request.claim().turn_id.starts_with("turn-nonce-call-"));
        let _ = request.arguments();
        let behavior = self.behavior.lock().expect("provider behavior").take();
        match behavior {
            Some(FakeExecutorBehavior::Return(outcome)) => outcome,
            Some(FakeExecutorBehavior::Pending) => future::pending().await,
            None => panic!("provider executor called more than once"),
        }
    }
}
