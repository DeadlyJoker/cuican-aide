use pretty_assertions::assert_eq;
use serde_json::Value;

use super::*;

const DISCOVERY_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_discovery.v1.json");

#[test]
fn canonical_discovery_commands_and_responses_round_trip_exactly() {
    let fixture: Value = serde_json::from_str(DISCOVERY_FIXTURE).expect("canonical fixture");
    let commands = fixture["commands"].as_array().expect("commands");

    let descriptor_command: ReadDescriptorCommand =
        serde_json::from_value(commands[0].clone()).expect("descriptor command");
    let list_command: ListResourcesCommand =
        serde_json::from_value(commands[1].clone()).expect("list command");
    let read_command: ReadResourceCommand =
        serde_json::from_value(commands[2].clone()).expect("read command");
    let descriptor: ProviderDescriptorWire =
        serde_json::from_value(fixture["descriptor"].clone()).expect("descriptor");
    let page: ProviderResourcePageWire =
        serde_json::from_value(fixture["page"].clone()).expect("page");
    let manifest: ProviderResourceManifestWire =
        serde_json::from_value(fixture["manifest"].clone()).expect("manifest");

    assert_eq!(
        serde_json::to_value(descriptor_command).expect("serialize"),
        commands[0]
    );
    assert_eq!(
        serde_json::to_value(list_command).expect("serialize"),
        commands[1]
    );
    assert_eq!(
        serde_json::to_value(read_command).expect("serialize"),
        commands[2]
    );
    assert_eq!(
        serde_json::to_value(&descriptor).expect("serialize"),
        fixture["descriptor"]
    );
    assert_eq!(
        serde_json::to_value(&page).expect("serialize"),
        fixture["page"]
    );
    assert_eq!(
        serde_json::to_value(&manifest).expect("serialize"),
        fixture["manifest"]
    );
    descriptor.validate().expect("valid descriptor");
    page.validate().expect("valid page");
}

#[test]
fn discovery_wire_rejects_unknown_fields_and_capabilities() {
    let fixture: Value = serde_json::from_str(DISCOVERY_FIXTURE).expect("canonical fixture");
    let mut unknown_field = fixture["manifest"].clone();
    unknown_field["prompt"] = Value::String("must not cross the catalog boundary".to_string());
    assert!(serde_json::from_value::<ProviderResourceManifestWire>(unknown_field).is_err());

    let mut unknown_capability = fixture["descriptor"].clone();
    unknown_capability["capabilities"]
        .as_array_mut()
        .expect("capabilities")
        .push(Value::String("oneShotFallback".to_string()));
    assert!(serde_json::from_value::<ProviderDescriptorWire>(unknown_capability).is_err());
}

#[test]
fn discovery_descriptor_requires_the_exact_implemented_capability_set() {
    let fixture: Value = serde_json::from_str(DISCOVERY_FIXTURE).expect("canonical fixture");
    let mut missing = fixture["descriptor"].clone();
    missing["capabilities"] = serde_json::json!(["durableRun", "remoteAgent"]);
    let descriptor: ProviderDescriptorWire =
        serde_json::from_value(missing).expect("known capability values");
    assert_eq!(
        descriptor.validate(),
        Err(AgentPlatformProviderError::Incompatible)
    );

    let mut duplicate = fixture["descriptor"].clone();
    duplicate["capabilities"] =
        serde_json::json!(["durableRun", "remoteAgent", "resumableEvents", "durableRun"]);
    let descriptor: ProviderDescriptorWire =
        serde_json::from_value(duplicate).expect("known capability values");
    assert_eq!(
        descriptor.validate(),
        Err(AgentPlatformProviderError::Incompatible)
    );
}
