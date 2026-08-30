use super::*;
use crate::ClientRequest;
use pretty_assertions::assert_eq;
use schemars::schema_for;
use serde_json::Value;
use std::collections::BTreeSet;

#[test]
fn canonical_platform_contract_fixture_round_trips_without_data_loss() {
    let fixture_path =
        crewon_utils_cargo_bin::find_resource!("schema/canonical/platform_contract.v2.json")
            .expect("canonical platform contract fixture");
    let fixture_value: Value = serde_json::from_slice(
        &std::fs::read(&fixture_path).expect("read canonical platform contract fixture"),
    )
    .expect("parse canonical platform contract fixture");

    let contract: PlatformContract =
        serde_json::from_value(fixture_value.clone()).expect("deserialize platform contract");
    let serialized = serde_json::to_value(&contract).expect("serialize platform contract");
    let round_trip =
        serde_json::from_value::<PlatformContract>(serialized.clone()).expect("round trip");

    assert_eq!(serialized, fixture_value);
    assert_eq!(round_trip, contract);
}

#[test]
fn credential_ref_serializes_only_safe_reference_fields() {
    let reference = CredentialRef {
        credential_id: "cred-1".to_string(),
        provider_id: "provider-1".to_string(),
        scope: CredentialScope::Space,
        status: CredentialStatus::Available,
        expires_at: Some(1_700_003_600),
        revision: 2,
    };

    assert_eq!(
        serde_json::to_value(reference).expect("serialize credential reference"),
        serde_json::json!({
            "credentialId": "cred-1",
            "providerId": "provider-1",
            "scope": "space",
            "status": "available",
            "expiresAt": 1_700_003_600_i64,
            "revision": 2,
        })
    );
}

#[test]
fn client_request_params_do_not_expose_server_authority_fields() {
    let schema = serde_json::to_value(schema_for!(ClientRequest)).expect("serialize schema");
    let mut property_names = BTreeSet::new();
    collect_property_names(&schema, &mut property_names);

    let forbidden = BTreeSet::from([
        "actorId",
        "authority",
        "credentialOwner",
        "spaceId",
        "strategy",
        "tenantId",
        "workspaceRoot",
    ]);
    let exposed = property_names
        .intersection(&forbidden)
        .copied()
        .collect::<BTreeSet<_>>();

    assert_eq!(exposed, BTreeSet::new());
}

fn collect_property_names<'a>(value: &'a Value, names: &mut BTreeSet<&'a str>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_property_names(value, names);
            }
        }
        Value::Object(object) => {
            if let Some(Value::Object(properties)) = object.get("properties") {
                names.extend(properties.keys().map(String::as_str));
            }
            for value in object.values() {
                collect_property_names(value, names);
            }
        }
        Value::Bool(_) | Value::Null | Value::Number(_) | Value::String(_) => {}
    }
}
