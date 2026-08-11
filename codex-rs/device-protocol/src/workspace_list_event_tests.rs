use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde_json::Value;

use super::parse_device_workspace_list_ack;
use super::parse_device_workspace_list_event;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    valid: ValidReference,
    workspace_invalid: Vec<InvalidReference>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidReference {
    workspace_ack: Value,
    workspace_events: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct InvalidReference {
    parser: String,
    code: String,
    value: Value,
}

#[test]
fn matches_typescript_workspace_event_ack_and_reject_vectors() {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve shared Device Protocol fixture");
    let fixture: Reference = serde_json::from_str(
        &std::fs::read_to_string(fixture_path).expect("read shared Device Protocol fixture"),
    )
    .expect("parse shared Device Protocol fixture");

    let events = fixture
        .valid
        .workspace_events
        .iter()
        .cloned()
        .map(|event| {
            serde_json::to_value(
                parse_device_workspace_list_event(event).expect("parse shared Workspace event"),
            )
            .expect("serialize shared Workspace event")
        })
        .collect::<Vec<_>>();
    assert_eq!(events, fixture.valid.workspace_events);
    assert_eq!(
        serde_json::to_value(
            parse_device_workspace_list_ack(fixture.valid.workspace_ack.clone())
                .expect("parse shared Workspace ACK")
        )
        .expect("serialize shared Workspace ACK"),
        fixture.valid.workspace_ack,
    );

    for invalid in fixture.workspace_invalid {
        let code = match invalid.parser.as_str() {
            "workspaceEvent" => {
                parse_device_workspace_list_event(invalid.value)
                    .expect_err("reject shared Workspace event")
                    .code
            }
            "workspaceAck" => {
                parse_device_workspace_list_ack(invalid.value)
                    .expect_err("reject shared Workspace ACK")
                    .code
            }
            parser => panic!("unsupported shared Workspace parser {parser}"),
        };
        assert_eq!(code, invalid.code);
    }
}

#[test]
fn rejects_result_identity_substitution_and_global_entry_cap() {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve shared Device Protocol fixture");
    let fixture: Reference = serde_json::from_str(
        &std::fs::read_to_string(fixture_path).expect("read shared Device Protocol fixture"),
    )
    .expect("parse shared Device Protocol fixture");
    let mut completed = fixture.valid.workspace_events[1].clone();
    completed["data"]["result"]["commandDigest"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    assert_eq!(
        parse_device_workspace_list_event(completed)
            .expect_err("result cannot substitute the command digest")
            .code,
        "device_workspace_result_identity_mismatch",
    );

    let mut oversized = fixture.valid.workspace_events[1].clone();
    oversized["data"]["result"]["entries"] = Value::Array(
        (0..201)
            .map(|index| {
                serde_json::json!({
                    "name": format!("entry-{index:03}"),
                    "kind": "file",
                })
            })
            .collect(),
    );
    assert_eq!(
        parse_device_workspace_list_event(oversized)
            .expect_err("global result entry cap is mandatory")
            .code,
        "device_workspace_result_invalid",
    );
}
