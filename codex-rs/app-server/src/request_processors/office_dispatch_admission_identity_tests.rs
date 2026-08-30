use super::*;
use pretty_assertions::assert_eq;

fn fields() -> OfficeDispatchAdmissionFields<'static> {
    OfficeDispatchAdmissionFields {
        record_id: "office-record-1",
        intent_id: "office-intent-1",
        source_thread_id: "source-thread-1",
        source_turn_id: "source-turn-1",
        target_thread_id: "target-thread-1",
        run_id: "run-1",
        dispatch_kind: "delegation",
        subject_id: "delegation-1",
        prompt: "Complete the assigned task.",
    }
}

#[test]
fn identical_fields_produce_stable_identity() {
    assert_eq!(
        derive_office_dispatch_admission_identity(fields()),
        derive_office_dispatch_admission_identity(fields())
    );
}

#[test]
fn every_payload_field_changes_the_payload_hash() {
    let base = fields();
    let expected = derive_office_dispatch_admission_identity(base);
    let variants = [
        OfficeDispatchAdmissionFields {
            record_id: "office-record-2",
            ..base
        },
        OfficeDispatchAdmissionFields {
            intent_id: "office-intent-2",
            ..base
        },
        OfficeDispatchAdmissionFields {
            source_thread_id: "source-thread-2",
            ..base
        },
        OfficeDispatchAdmissionFields {
            source_turn_id: "source-turn-2",
            ..base
        },
        OfficeDispatchAdmissionFields {
            target_thread_id: "target-thread-2",
            ..base
        },
        OfficeDispatchAdmissionFields {
            run_id: "run-2",
            ..base
        },
        OfficeDispatchAdmissionFields {
            dispatch_kind: "verification",
            ..base
        },
        OfficeDispatchAdmissionFields {
            subject_id: "delegation-2",
            ..base
        },
        OfficeDispatchAdmissionFields {
            prompt: "Complete a different task.",
            ..base
        },
    ];

    for variant in variants {
        assert_ne!(
            derive_office_dispatch_admission_identity(variant).payload_hash,
            expected.payload_hash
        );
    }
}

#[test]
fn client_id_is_bounded_and_payload_hash_is_lowercase_sha256() {
    let identity = derive_office_dispatch_admission_identity(fields());

    assert!(identity.client_id.len() <= MAX_CLIENT_ID_BYTES);
    assert_eq!(identity.payload_hash.len(), 64);
    assert!(
        identity
            .payload_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
}

#[test]
fn length_prefixing_prevents_field_boundary_ambiguity() {
    let left = derive_office_dispatch_admission_identity(OfficeDispatchAdmissionFields {
        record_id: "ab",
        intent_id: "c",
        ..fields()
    });
    let right = derive_office_dispatch_admission_identity(OfficeDispatchAdmissionFields {
        record_id: "a",
        intent_id: "bc",
        ..fields()
    });

    assert_ne!(left, right);
}
