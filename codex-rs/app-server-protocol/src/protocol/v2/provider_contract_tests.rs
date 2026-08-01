use super::*;
use pretty_assertions::assert_eq;
use serde_json::Value;

#[test]
fn canonical_provider_contract_round_trips_without_data_loss() {
    let fixture = canonical_fixture();
    let contract: ProviderContract =
        serde_json::from_value(fixture.clone()).expect("deserialize provider contract");
    contract.validate().expect("validate provider contract");

    assert_eq!(
        serde_json::to_value(contract).expect("serialize provider contract"),
        fixture
    );
}

#[test]
fn provider_contract_rejects_wire_and_invariant_drift() {
    let fixture = canonical_fixture();

    let mut missing = fixture.clone();
    missing["authorization"]
        .as_object_mut()
        .expect("authorization object")
        .remove("spaceId");
    assert_contract_rejected("missing", missing);

    let mut extra = fixture.clone();
    extra["authorization"]["credential"]["secret"] = Value::String("must-not-pass".into());
    assert_contract_rejected("extra", extra);

    let mut missing_credential_revision = fixture.clone();
    missing_credential_revision["authorization"]["credential"]
        .as_object_mut()
        .expect("credential object")
        .remove("revision");
    assert_contract_rejected("credential-revision", missing_credential_revision);

    let mut nested_extra = fixture.clone();
    nested_extra["commands"][0]["resource"]["authority"] =
        Value::String("client-must-not-control".into());
    assert_contract_rejected("nested-extra", nested_extra);

    let mut renamed = fixture.clone();
    let start = renamed["commands"][0]
        .as_object_mut()
        .expect("start command object");
    let command_id = start.remove("commandId").expect("commandId");
    start.insert("commandID".into(), command_id);
    assert_contract_rejected("rename", renamed);

    let mut wrong_tag = fixture.clone();
    wrong_tag["commands"][0]["type"] = Value::String("launch".into());
    assert_contract_rejected("tag", wrong_tag);

    let mut missing_nullable = fixture.clone();
    missing_nullable["commands"][2]
        .as_object_mut()
        .expect("listEvents command object")
        .remove("afterCursor");
    assert_contract_rejected("nullable", missing_nullable);

    let mut wrong_error = fixture.clone();
    wrong_error["error"]["code"] = Value::String("providerBroke".into());
    assert_contract_rejected("error", wrong_error);

    let mut capability_drift = fixture.clone();
    capability_drift["provider"]["capabilities"]
        .as_array_mut()
        .expect("capabilities array")
        .remove(0);
    assert_contract_rejected("capability", capability_drift);

    let mut ordering_drift = fixture;
    ordering_drift["events"][1]["sequence"] = Value::from(7);
    assert_contract_rejected("ordering", ordering_drift);

    let mut tool_intent_drift = canonical_fixture();
    tool_intent_drift["commands"][5]["intentDigest"] =
        Value::String("sha256:another-intent".into());
    assert_contract_rejected("tool-intent", tool_intent_drift);

    let mut context_task_drift = canonical_fixture();
    context_task_drift["commands"][0]["input"]["contextRefs"][0]["taskId"] =
        Value::String("task-other".into());
    assert_contract_rejected("context-task", context_task_drift);

    let mut output_task_drift = canonical_fixture();
    output_task_drift["events"][5]["outputArtifacts"][0]["taskId"] =
        Value::String("task-other".into());
    assert_contract_rejected("output-task", output_task_drift);
}

fn assert_contract_rejected(mutation: &str, value: Value) {
    let rejected = serde_json::from_value::<ProviderContract>(value)
        .map_err(|error| error.to_string())
        .and_then(|contract| contract.validate());
    assert!(rejected.is_err(), "mutation {mutation} was accepted");
}

fn canonical_fixture() -> Value {
    let path = crewon_utils_cargo_bin::find_resource!("schema/canonical/provider_contract.v3.json")
        .expect("canonical provider contract fixture");
    serde_json::from_slice(&std::fs::read(path).expect("read provider contract fixture"))
        .expect("parse provider contract fixture")
}
