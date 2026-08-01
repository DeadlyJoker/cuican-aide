use pretty_assertions::assert_eq;
use serde_json::Value;

use crate::ProviderIdentitySourceError;
use crate::ProviderIdentitySourceSnapshot;
use crate::ProviderIdentitySourceStatus;

const CANONICAL: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");
const NOW: i64 = 1_785_000_061;

#[test]
fn canonical_identity_source_contract_parses_and_redacts_identity() {
    let snapshot = ProviderIdentitySourceSnapshot::parse(CANONICAL.as_bytes(), NOW)
        .expect("canonical identity source");
    let binding = snapshot.binding();

    assert_eq!(
        binding.source_binding_id(),
        "019f6f00-0000-7000-8000-000000000001"
    );
    assert_eq!(binding.source_revision(), 1);
    assert_eq!(binding.status(), ProviderIdentitySourceStatus::Active);
    assert_eq!(
        binding.local_actor_id(),
        "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f"
    );
    assert_eq!(binding.local_tenant_id(), "7");
    assert_eq!(binding.local_space_id(), "11");
    assert_eq!(binding.provider_subject(), "user:42");
    assert_eq!(binding.provider_tenant_id(), "7");
    assert_eq!(binding.provider_space_id(), "11");
    assert_eq!(snapshot.issued_at(), 1_785_000_060);
    assert_eq!(snapshot.fresh_until(), 1_785_000_120);

    let debug = format!("{snapshot:?}");
    assert!(!debug.contains(binding.local_actor_id()));
    assert!(!debug.contains(binding.provider_subject()));
}

#[test]
fn identity_source_contract_rejects_wire_and_authority_drift() {
    let mutations: &[fn(&mut Value)] = &[
        |wire| {
            wire["binding"]["providerIdentity"]
                .as_object_mut()
                .expect("provider identity")
                .remove("subject");
        },
        |wire| wire["binding"]["providerIdentity"]["email"] = "must-not-pass".into(),
        |wire| wire["binding"]["localOwner"]["actorId"] = "remote-websocket:session".into(),
        |wire| wire["binding"]["providerIdentity"]["spaceId"] = "12".into(),
        |wire| wire["binding"]["sourceRevision"] = 2.into(),
        |wire| wire["binding"]["status"] = "suspended".into(),
        |wire| wire["binding"]["bindingDigest"] = format!("sha256:{}", "0".repeat(64)).into(),
        |wire| wire["freshness"]["freshUntil"] = 1_785_000_121_i64.into(),
        |wire| wire["binding"]["sourceBindingId"] = "binding-1".into(),
        |wire| wire["binding"]["localOwner"]["tenantId"] = (1_u128 << 64).to_string().into(),
    ];

    for mutate in mutations {
        let mut wire: Value = serde_json::from_str(CANONICAL).expect("canonical JSON");
        mutate(&mut wire);
        let encoded = serde_json::to_vec(&wire).expect("mutated JSON");
        assert_eq!(
            ProviderIdentitySourceSnapshot::parse(&encoded, NOW).expect_err("drift rejected"),
            ProviderIdentitySourceError::InvalidResponse
        );
    }
}

#[test]
fn identity_source_contract_rejects_stale_and_far_future_snapshots() {
    assert_eq!(
        ProviderIdentitySourceSnapshot::parse(CANONICAL.as_bytes(), 1_785_000_120)
            .expect_err("stale snapshot"),
        ProviderIdentitySourceError::NotFresh
    );
    assert_eq!(
        ProviderIdentitySourceSnapshot::parse(CANONICAL.as_bytes(), 1_784_999_759)
            .expect_err("future snapshot"),
        ProviderIdentitySourceError::InvalidResponse
    );
}
