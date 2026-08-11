use crewon_device_protocol::DEVICE_PROTOCOL_VERSION;
use crewon_device_protocol::DeviceCommandAuthorization;
use crewon_device_protocol::DeviceTraceContext;
use crewon_device_protocol::DeviceWorkspaceListAcceptedData;
use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListCompletedData;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::DeviceWorkspaceListEventEnvelope;
use crewon_device_protocol::DeviceWorkspaceListFailedData;
use crewon_device_protocol::DeviceWorkspaceListLimits;
use crewon_device_protocol::DeviceWorkspaceListResult;

pub(crate) fn authority(
    suffix: usize,
) -> (DeviceWorkspaceListCommand, DeviceWorkspaceListEvent) {
    let action_digest = format!("sha256:{}", "a".repeat(64));
    let command_digest = format!("sha256:{}", "b".repeat(64));
    let execution_id = format!("workspace-execution-{suffix:03}");
    let receipt_id = format!("workspace-receipt-{suffix:03}");
    let command = DeviceWorkspaceListCommand {
        schema_version: "crewon.device-workspace-list-command.v0".to_string(),
        protocol_version: DEVICE_PROTOCOL_VERSION,
        command_kind: "workspaceList".to_string(),
        device_id: "device-1".to_string(),
        execution_id,
        lease_id: format!("lease-{suffix:03}"),
        lease_epoch: 4,
        expires_at: "2026-08-08T01:00:00Z".to_string(),
        workspace_binding_id: "workspace-binding-1".to_string(),
        incarnation_id: "incarnation-1".to_string(),
        device_binding_id: "device-binding-1".to_string(),
        runtime_binding_id: "runtime-binding-1".to_string(),
        policy_snapshot_id: "policy-1".to_string(),
        operation: "listTopLevel".to_string(),
        limits: DeviceWorkspaceListLimits {
            depth: 0,
            max_entries: 200,
            max_name_bytes: 255,
            max_output_bytes: 65_536,
            max_scanned_entries: 10_000,
            max_scanned_name_bytes: 1_048_576,
            timeout_ms: 30_000,
        },
        action_digest,
        command_digest,
        idempotency_key: format!("workspace-key-{suffix:03}"),
        trace_context: DeviceTraceContext {
            traceparent: None,
            tracestate: None,
        },
        authorization: DeviceCommandAuthorization {
            schema_version: "crewon.device-authorization.v0".to_string(),
            scheme: "ed25519".to_string(),
            key_id: "control-key-1".to_string(),
            issued_at: "2026-08-08T00:00:00Z".to_string(),
            expires_at: "2026-08-08T00:30:00Z".to_string(),
            approval_proof: None,
            signature: "A".repeat(86),
        },
    };
    let accepted = DeviceWorkspaceListEvent::Accepted {
        envelope: envelope(&command, receipt_id, 1, "2026-08-08T00:00:01Z"),
        data: DeviceWorkspaceListAcceptedData {
            lease_id: command.lease_id.clone(),
            lease_epoch: command.lease_epoch,
            expires_at: command.expires_at.clone(),
            policy_snapshot_id: command.policy_snapshot_id.clone(),
        },
    };
    (command, accepted)
}

pub(crate) fn completed(
    command: &DeviceWorkspaceListCommand,
    accepted: &DeviceWorkspaceListEvent,
) -> DeviceWorkspaceListEvent {
    DeviceWorkspaceListEvent::Completed {
        envelope: envelope(
            command,
            receipt_id(accepted),
            2,
            "2026-08-08T00:00:02Z",
        ),
        data: DeviceWorkspaceListCompletedData {
            result: DeviceWorkspaceListResult {
                schema_version: "crewon.workspace-list-result.v0".to_string(),
                execution_id: command.execution_id.clone(),
                action_digest: command.action_digest.clone(),
                command_digest: command.command_digest.clone(),
                entries: Vec::new(),
                truncated: false,
            },
        },
    }
}

pub(crate) fn failed(
    command: &DeviceWorkspaceListCommand,
    accepted: &DeviceWorkspaceListEvent,
) -> DeviceWorkspaceListEvent {
    DeviceWorkspaceListEvent::Failed {
        envelope: envelope(
            command,
            receipt_id(accepted),
            2,
            "2026-08-08T00:00:03Z",
        ),
        data: DeviceWorkspaceListFailedData {
            code: "workspace_list_failed".to_string(),
            retryable: false,
        },
    }
}

pub(crate) fn ack(
    command: &DeviceWorkspaceListCommand,
    accepted: &DeviceWorkspaceListEvent,
    through_sequence: u64,
) -> DeviceWorkspaceListAck {
    let envelope = event_envelope(accepted);
    DeviceWorkspaceListAck {
        schema_version: "crewon.device-workspace-list-ack.v0".to_string(),
        protocol_version: DEVICE_PROTOCOL_VERSION,
        command_kind: "workspaceList".to_string(),
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        receipt_id: envelope.receipt_id.clone(),
        connection_epoch: envelope.connection_epoch,
        workspace_binding_id: command.workspace_binding_id.clone(),
        incarnation_id: command.incarnation_id.clone(),
        device_binding_id: command.device_binding_id.clone(),
        runtime_binding_id: command.runtime_binding_id.clone(),
        action_digest: command.action_digest.clone(),
        command_digest: command.command_digest.clone(),
        through_sequence,
        acknowledged_at: format!("2026-08-08T00:00:0{}Z", through_sequence + 4),
    }
}

pub(crate) fn set_receipt_id(event: &mut DeviceWorkspaceListEvent, receipt_id: String) {
    match event {
        DeviceWorkspaceListEvent::Accepted { envelope, .. }
        | DeviceWorkspaceListEvent::Completed { envelope, .. }
        | DeviceWorkspaceListEvent::Failed { envelope, .. }
        | DeviceWorkspaceListEvent::Canceled { envelope, .. }
        | DeviceWorkspaceListEvent::UnknownOutcome { envelope, .. } => {
            envelope.receipt_id = receipt_id;
        }
    }
}

fn envelope(
    command: &DeviceWorkspaceListCommand,
    receipt_id: String,
    sequence: u64,
    observed_at: &str,
) -> DeviceWorkspaceListEventEnvelope {
    DeviceWorkspaceListEventEnvelope {
        schema_version: "crewon.device-workspace-list-event.v0".to_string(),
        protocol_version: DEVICE_PROTOCOL_VERSION,
        command_kind: "workspaceList".to_string(),
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        receipt_id,
        connection_epoch: 3,
        workspace_binding_id: command.workspace_binding_id.clone(),
        incarnation_id: command.incarnation_id.clone(),
        device_binding_id: command.device_binding_id.clone(),
        runtime_binding_id: command.runtime_binding_id.clone(),
        action_digest: command.action_digest.clone(),
        command_digest: command.command_digest.clone(),
        sequence,
        observed_at: observed_at.to_string(),
    }
}

fn receipt_id(event: &DeviceWorkspaceListEvent) -> String {
    event_envelope(event).receipt_id.clone()
}

fn event_envelope(event: &DeviceWorkspaceListEvent) -> &DeviceWorkspaceListEventEnvelope {
    match event {
        DeviceWorkspaceListEvent::Accepted { envelope, .. }
        | DeviceWorkspaceListEvent::Completed { envelope, .. }
        | DeviceWorkspaceListEvent::Failed { envelope, .. }
        | DeviceWorkspaceListEvent::Canceled { envelope, .. }
        | DeviceWorkspaceListEvent::UnknownOutcome { envelope, .. } => envelope,
    }
}
