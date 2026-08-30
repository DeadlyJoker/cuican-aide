use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_protocol::DeviceAcceptedData;
use crewon_device_protocol::DeviceExecutionCancel;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::DeviceExecutionEventEnvelope;
use pretty_assertions::assert_eq;
use url::Url;

use super::CancelDisposition;
use super::apply_cancel;
use super::register_cancellation;
use crate::test_support::ServerPin;
use crate::test_support::accepted_event;
use crate::test_support::read_accepted_event;
use crate::test_support::runtime_fixture;
use crate::test_support::signed_command;
use crate::test_support::signed_raw_read_command;
use crate::test_support::signed_read_command;

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

#[tokio::test]
async fn accepted_only_read_cancel_is_safe_and_lease_exact() {
    let fixture = runtime_fixture(
        Url::parse("wss://localhost/device/v1").expect("gateway URL"),
        ServerPin::Omitted,
    )
    .await;
    let command = signed_read_command(&fixture, 302);
    let accepted = read_accepted_event(&command, 1);
    fixture
        .runtime
        .state
        .journal
        .prepare_filesystem_read(&command, &accepted)
        .await
        .expect("prepare accepted-only read");
    let cancel = DeviceExecutionCancel {
        schema_version: "crewon.device-cancel.v0".to_string(),
        protocol_version: 1,
        device_id: command.command.device_id.clone(),
        execution_id: command.command.execution_id.clone(),
        lease_id: command.command.lease_id.clone(),
        lease_epoch: command.command.lease_epoch,
        reason_code: "user_requested".to_string(),
        requested_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &cancel)
            .await
            .expect("ignore inactive accepted-only read"),
        CancelDisposition::IgnoredInactive
    );
    let mut forged = cancel;
    forged.lease_epoch += 1;
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &forged)
            .await
            .expect_err("reject forged read cancel")
            .code,
        "device_runtime_cancel_identity_mismatch"
    );
}

#[tokio::test]
async fn accepted_only_raw_tool_cancel_is_safe_and_lease_exact() {
    let fixture = runtime_fixture(
        Url::parse("wss://localhost/device/v1").expect("gateway URL"),
        ServerPin::Omitted,
    )
    .await;
    let command = signed_raw_read_command(&fixture, 303);
    let accepted = DeviceExecutionEvent::Accepted {
        envelope: DeviceExecutionEventEnvelope {
            schema_version: "crewon.device-event.v0".to_string(),
            protocol_version: command.command.protocol_version,
            device_id: command.command.device_id.clone(),
            execution_id: command.command.execution_id.clone(),
            receipt_id: "tool-receipt-late-cancel".to_string(),
            sequence: 1,
            observed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        },
        data: DeviceAcceptedData {
            lease_epoch: command.command.lease_epoch,
            action_digest: command.command.action_digest.clone(),
        },
    };
    fixture
        .runtime
        .state
        .journal
        .prepare_tool_with_admission(&command.command, || Ok::<_, ()>((accepted, ())))
        .await
        .expect("record accepted raw Tool execution");
    let cancel = DeviceExecutionCancel {
        schema_version: "crewon.device-cancel.v0".to_string(),
        protocol_version: 1,
        device_id: command.command.device_id.clone(),
        execution_id: command.command.execution_id.clone(),
        lease_id: command.command.lease_id.clone(),
        lease_epoch: command.command.lease_epoch,
        reason_code: "user_requested".to_string(),
        requested_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &cancel)
            .await
            .expect("ignore inactive terminal raw Tool cancel"),
        CancelDisposition::IgnoredInactive
    );
    let mut forged = cancel;
    forged.lease_id = "forged-lease".to_string();
    assert_eq!(
        apply_cancel(&fixture.runtime.state, &forged)
            .await
            .expect_err("reject forged raw Tool cancel")
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
