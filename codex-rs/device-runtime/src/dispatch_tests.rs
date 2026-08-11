use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_protocol::DeviceExecutionCancel;
use pretty_assertions::assert_eq;
use url::Url;

use super::CancelDisposition;
use super::apply_cancel;
use super::register_cancellation;
use crate::test_support::ServerPin;
use crate::test_support::accepted_event;
use crate::test_support::runtime_fixture;
use crate::test_support::signed_command;

#[tokio::test]
async fn accepted_only_and_terminal_late_cancel_are_safe_exact_noops() {
    let fixture = runtime_fixture(
        Url::parse("wss://localhost/device/v1").expect("gateway URL"),
        ServerPin::Omitted,
    )
    .await;
    let command = signed_command(&fixture, 300);
    let accepted = accepted_event(&command, 1);
    fixture
        .runtime
        .state
        .journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("prepare accepted-only authority");
    let cancel = cancel_for(&command);

    assert_eq!(
        apply_cancel(&fixture.runtime.state, &cancel)
            .await
            .expect("ignore accepted-only cancel"),
        CancelDisposition::IgnoredInactive
    );
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &cancel)
            .await
            .expect("ignore duplicate cancel"),
        CancelDisposition::IgnoredInactive
    );

    let mut forged = cancel;
    forged.lease_id = "different-lease".to_string();
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &forged)
            .await
            .expect_err("reject forged late cancel")
            .code,
        "device_runtime_cancel_identity_mismatch"
    );
}

#[tokio::test]
async fn active_cancel_requires_exact_execution_lease_identity() {
    let fixture = runtime_fixture(
        Url::parse("wss://localhost/device/v1").expect("gateway URL"),
        ServerPin::Omitted,
    )
    .await;
    let command = signed_command(&fixture, 301);
    let (_cancellation, owner) =
        register_cancellation(&fixture.runtime.state, &command).expect("register active command");
    assert!(owner);
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &cancel_for(&command))
            .await
            .expect("apply active cancel"),
        CancelDisposition::Applied
    );

    let mut forged = cancel_for(&command);
    forged.lease_epoch += 1;
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &forged)
            .await
            .expect_err("reject stale cancel")
            .code,
        "device_runtime_cancel_identity_mismatch"
    );
}

fn cancel_for(
    command: &crewon_device_protocol::DeviceWorkspaceListCommand,
) -> DeviceExecutionCancel {
    DeviceExecutionCancel {
        schema_version: "crewon.device-cancel.v0".to_string(),
        protocol_version: 1,
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        lease_id: command.lease_id.clone(),
        lease_epoch: command.lease_epoch,
        reason_code: "user_requested".to_string(),
        requested_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}
