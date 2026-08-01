use pretty_assertions::assert_eq;

use super::*;

fn absolute_path(path: &str) -> AbsolutePathBuf {
    AbsolutePathBuf::from_absolute_path(path).expect("test path should be absolute")
}

#[test]
fn durable_admission_requires_both_feature_gates() {
    assert_eq!(
        resolve_admission_mode(false, false).expect("legacy mode should remain available"),
        OfficeAutoDelegationAdmissionMode::Legacy
    );
    assert_eq!(
        resolve_admission_mode(false, true).expect("legacy mode should remain available"),
        OfficeAutoDelegationAdmissionMode::Legacy
    );

    let missing_once_gate = resolve_admission_mode(true, false)
        .expect_err("durable admission requires user_input_once");
    assert!(matches!(
        missing_once_gate,
        OfficeDurableTurnError::Disabled
    ));
    assert_eq!(
        missing_once_gate.certainty(),
        OfficeDurableAdmissionCertainty::NotAdmitted
    );

    assert_eq!(
        resolve_admission_mode(true, true).expect("both gates enable durable admission"),
        OfficeAutoDelegationAdmissionMode::Durable
    );
}

#[test]
fn cwd_precondition_failure_preserves_exact_paths_and_is_not_admitted() {
    let expected_cwd = absolute_path("/workspace/expected");
    let actual_cwd = absolute_path("/workspace/actual");

    let mapped = map_admission_error(SubmitUserInputOnceError::TurnContextPreconditionFailed {
        expected_cwd: expected_cwd.clone(),
        actual_cwd: actual_cwd.clone(),
    });

    assert_eq!(
        mapped.certainty(),
        OfficeDurableAdmissionCertainty::NotAdmitted
    );
    let OfficeDurableTurnError::TurnContextPreconditionFailed {
        expected_cwd: mapped_expected,
        actual_cwd: mapped_actual,
    } = mapped
    else {
        panic!("cwd mismatch should retain its dedicated error shape");
    };
    assert_eq!((mapped_expected, mapped_actual), (expected_cwd, actual_cwd));
}

#[test]
fn admission_error_certainty_distinguishes_retry_risk_from_identity_conflict() {
    let persistence = map_admission_error(SubmitUserInputOnceError::Persistence(
        "admission marker flush failed".to_string(),
    ));
    let conflict = map_admission_error(SubmitUserInputOnceError::Conflict {
        turn_id: "turn-existing".to_string(),
    });
    let legacy = map_admission_error(SubmitUserInputOnceError::Legacy);

    assert_eq!(
        persistence.certainty(),
        OfficeDurableAdmissionCertainty::Ambiguous
    );
    assert_eq!(
        conflict.certainty(),
        OfficeDurableAdmissionCertainty::Conflict
    );
    assert_eq!(
        legacy.certainty(),
        OfficeDurableAdmissionCertainty::Conflict
    );
}

#[test]
fn durable_request_uses_once_admission_with_exact_cwd_and_no_turn_overrides() {
    let expected_cwd = absolute_path("/workspace/exact");
    let request = build_admission_request(
        "office-client".to_string(),
        "payload-sha256".to_string(),
        vec![crewon_protocol::user_input::UserInput::Text {
            text: "delegate this task".to_string(),
            text_elements: Vec::new(),
        }],
        expected_cwd.clone(),
    );

    assert_eq!(request.client_id, "office-client");
    assert_eq!(request.payload_hash, "payload-sha256");
    assert_eq!(
        request.turn_context_precondition,
        TurnContextPrecondition::CwdEquals(expected_cwd)
    );

    let Op::UserInput {
        items,
        final_output_json_schema,
        responsesapi_client_metadata,
        additional_context,
        thread_settings,
    } = request.op
    else {
        panic!("durable admission must submit a user-input operation");
    };
    assert_eq!(
        items,
        vec![crewon_protocol::user_input::UserInput::Text {
            text: "delegate this task".to_string(),
            text_elements: Vec::new(),
        }]
    );
    assert_eq!(final_output_json_schema, None);
    assert_eq!(responsesapi_client_metadata, None);
    assert!(additional_context.is_empty());
    assert_eq!(thread_settings, Default::default());
}
