use super::*;
use crewon_protocol::protocol::ResumedHistory;
use crewon_protocol::protocol::TurnCompleteEvent;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
use crewon_protocol::protocol::UserMessageEvent;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn marker_with_version(
    thread_id: ThreadId,
    client_id: &str,
    hash: &str,
    turn_id: &str,
    version: u8,
) -> RolloutItem {
    RolloutItem::UserInputOnceMarker(UserInputOnceMarker {
        version,
        phase: UserInputOnceMarkerPhase::Admission,
        thread_id,
        client_id: client_id.to_string(),
        payload_hash: hash.to_string(),
        turn_id: turn_id.to_string(),
    })
}

fn legacy_marker(thread_id: ThreadId, client_id: &str, hash: &str, turn_id: &str) -> RolloutItem {
    marker_with_version(thread_id, client_id, hash, turn_id, LEGACY_MARKER_VERSION)
}

fn marker(thread_id: ThreadId, client_id: &str, hash: &str, turn_id: &str) -> RolloutItem {
    marker_with_version(thread_id, client_id, hash, turn_id, MARKER_VERSION)
}

fn fence(thread_id: ThreadId, client_id: &str, hash: &str, turn_id: &str) -> RolloutItem {
    RolloutItem::UserInputOnceMarker(UserInputOnceMarker {
        version: EXECUTION_FENCE_VERSION,
        phase: UserInputOnceMarkerPhase::ExecutionFence,
        thread_id,
        client_id: client_id.to_string(),
        payload_hash: hash.to_string(),
        turn_id: turn_id.to_string(),
    })
}

fn user(client_id: &str) -> RolloutItem {
    RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
        client_id: Some(client_id.to_string()),
        message: "hello".to_string(),
        ..Default::default()
    }))
}

fn turn_complete(turn_id: impl Into<String>) -> RolloutItem {
    RolloutItem::EventMsg(EventMsg::TurnComplete(TurnCompleteEvent {
        turn_id: turn_id.into(),
        last_agent_message: None,
        completed_at: None,
        duration_ms: None,
        time_to_first_token_ms: None,
    }))
}

fn resumed(thread_id: ThreadId, history: Vec<RolloutItem>) -> InitialHistory {
    InitialHistory::Resumed(ResumedHistory {
        conversation_id: thread_id,
        history,
        rollout_path: None,
    })
}

#[test]
fn rebuilds_persisted_and_admission_only_receipts() {
    let thread_id = ThreadId::new();
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![
                marker(thread_id, "persisted", HASH_A, "turn-1"),
                fence(thread_id, "persisted", HASH_A, "turn-1"),
                user("persisted"),
                marker(thread_id, "marker-only", HASH_B, "turn-2"),
                marker(thread_id, "persisted-without-fence", HASH_A, "turn-3"),
                user("persisted-without-fence"),
            ],
        ),
        thread_id,
    );

    assert_eq!(
        index.lookup("persisted", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "turn-1".to_string(),
            state: UserInputOnceState::Persisted,
            execution_state: UserInputOnceExecutionState::Started,
        }))
    );
    assert_eq!(
        index.lookup("marker-only", HASH_B),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "turn-2".to_string(),
            state: UserInputOnceState::AdmissionOnly,
            execution_state: UserInputOnceExecutionState::NotStarted,
        }))
    );
    assert_eq!(
        index.lookup("persisted-without-fence", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "turn-3".to_string(),
            state: UserInputOnceState::Persisted,
            execution_state: UserInputOnceExecutionState::LegacyUnknown,
        }))
    );
}

#[test]
fn legacy_markers_remain_readable_but_never_claim_not_started() {
    let thread_id = ThreadId::new();
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![legacy_marker(thread_id, "legacy-v1", HASH_A, "turn-v1")],
        ),
        thread_id,
    );

    assert_eq!(
        index.lookup("legacy-v1", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "turn-v1".to_string(),
            state: UserInputOnceState::AdmissionOnly,
            execution_state: UserInputOnceExecutionState::LegacyUnknown,
        }))
    );
}

#[test]
fn mismatched_or_out_of_order_fences_fail_closed() {
    let thread_id = ThreadId::new();
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![
                marker(thread_id, "mismatch", HASH_A, "turn-a"),
                fence(thread_id, "mismatch", HASH_B, "turn-a"),
                fence(thread_id, "out-of-order", HASH_A, "turn-b"),
                marker(thread_id, "out-of-order", HASH_A, "turn-b"),
            ],
        ),
        thread_id,
    );

    assert_eq!(
        index.lookup("mismatch", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "turn-a".to_string(),
            state: UserInputOnceState::AdmissionOnly,
            execution_state: UserInputOnceExecutionState::LegacyUnknown,
        }))
    );
    assert_eq!(
        index.lookup("out-of-order", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
}

#[test]
fn later_unknown_or_wrong_thread_markers_poison_an_admission() {
    let thread_id = ThreadId::new();
    let foreign_thread_id = ThreadId::new();
    let mut unknown = marker(thread_id, "unknown-after", HASH_A, "turn-a");
    let RolloutItem::UserInputOnceMarker(unknown_marker) = &mut unknown else {
        unreachable!()
    };
    unknown_marker.phase = UserInputOnceMarkerPhase::Unknown;
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![
                marker(thread_id, "unknown-after", HASH_A, "turn-a"),
                unknown,
                marker(thread_id, "foreign-fence", HASH_A, "turn-b"),
                fence(foreign_thread_id, "foreign-fence", HASH_A, "turn-b"),
            ],
        ),
        thread_id,
    );

    assert_eq!(
        index.lookup("unknown-after", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("foreign-fence", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
}

#[test]
fn unknown_phase_and_capacity_overflow_fail_closed() {
    let thread_id = ThreadId::new();
    let mut unknown = marker(thread_id, "unknown-phase", HASH_A, "unknown-turn");
    let RolloutItem::UserInputOnceMarker(unknown_marker) = &mut unknown else {
        unreachable!()
    };
    unknown_marker.phase = UserInputOnceMarkerPhase::Unknown;
    let mut history = vec![unknown];
    history.extend((0..MAX_ENTRIES).map(|index| {
        marker(
            thread_id,
            &format!("bounded-{index}"),
            HASH_A,
            &format!("turn-{index}"),
        )
    }));
    let index = UserInputOnceIndex::from_history(&resumed(thread_id, history), thread_id);

    assert_eq!(
        index.lookup("unknown-phase", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("bounded-0", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "turn-0".to_string(),
            state: UserInputOnceState::AdmissionOnly,
            execution_state: UserInputOnceExecutionState::NotStarted,
        }))
    );
    assert_eq!(
        index.lookup("not-recorded-after-overflow", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
}

#[test]
fn exact_capacity_rejects_unknown_identities_without_hiding_existing_entries() {
    let thread_id = ThreadId::new();
    let history = (0..MAX_ENTRIES)
        .map(|index| {
            marker(
                thread_id,
                &format!("exact-cap-{index}"),
                HASH_A,
                &format!("exact-turn-{index}"),
            )
        })
        .collect();
    let index = UserInputOnceIndex::from_history(&resumed(thread_id, history), thread_id);

    assert_eq!(
        index.lookup("exact-cap-0", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "exact-turn-0".to_string(),
            state: UserInputOnceState::AdmissionOnly,
            execution_state: UserInputOnceExecutionState::NotStarted,
        }))
    );
    assert_eq!(
        index.lookup("beyond-exact-cap", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
}

#[test]
fn durable_admission_classifier_requires_one_exact_admission() {
    let thread_id = ThreadId::new();
    let RolloutItem::UserInputOnceMarker(expected) = marker(thread_id, "classify", HASH_A, "turn")
    else {
        unreachable!()
    };
    assert_eq!(
        classify_durable_admission(&[], &expected),
        DurableAdmissionMatch::Absent
    );
    assert_eq!(
        classify_durable_admission(
            &[RolloutItem::UserInputOnceMarker(expected.clone())],
            &expected,
        ),
        DurableAdmissionMatch::Exact
    );
    assert_eq!(
        classify_durable_admission(
            &[
                RolloutItem::UserInputOnceMarker(expected.clone()),
                fence(thread_id, "classify", HASH_A, "turn"),
            ],
            &expected,
        ),
        DurableAdmissionMatch::Ambiguous
    );
}

#[test]
fn durable_execution_fence_classifier_requires_exact_order_and_identity() {
    let thread_id = ThreadId::new();
    let RolloutItem::UserInputOnceMarker(expected) =
        fence(thread_id, "fence-classify", HASH_A, "turn")
    else {
        unreachable!()
    };
    let admission = marker(thread_id, "fence-classify", HASH_A, "turn");

    assert_eq!(
        classify_durable_execution_fence(std::slice::from_ref(&admission), &expected),
        DurableExecutionFenceMatch::Absent
    );
    assert_eq!(
        classify_durable_execution_fence(
            &[
                admission.clone(),
                RolloutItem::UserInputOnceMarker(expected.clone()),
            ],
            &expected,
        ),
        DurableExecutionFenceMatch::Exact
    );
    assert_eq!(
        classify_durable_execution_fence(
            &[
                RolloutItem::UserInputOnceMarker(expected.clone()),
                admission.clone(),
            ],
            &expected,
        ),
        DurableExecutionFenceMatch::Ambiguous
    );
    assert_eq!(
        classify_durable_execution_fence(
            &[
                admission,
                RolloutItem::UserInputOnceMarker(expected.clone()),
                RolloutItem::UserInputOnceMarker(expected),
            ],
            &UserInputOnceMarker {
                version: EXECUTION_FENCE_VERSION,
                phase: UserInputOnceMarkerPhase::ExecutionFence,
                thread_id,
                client_id: "fence-classify".to_string(),
                payload_hash: HASH_A.to_string(),
                turn_id: "turn".to_string(),
            },
        ),
        DurableExecutionFenceMatch::Ambiguous
    );
}

#[test]
fn exact_turn_lifecycle_without_a_fence_is_not_restartable() {
    let thread_id = ThreadId::new();
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![
                marker(thread_id, "terminal-without-fence", HASH_A, "terminal-turn"),
                turn_complete("terminal-turn"),
            ],
        ),
        thread_id,
    );

    assert_eq!(
        index.lookup("terminal-without-fence", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "terminal-turn".to_string(),
            state: UserInputOnceState::AdmissionOnly,
            execution_state: UserInputOnceExecutionState::LegacyUnknown,
        }))
    );
}

#[test]
fn unrelated_lifecycle_volume_cannot_hide_exact_terminal_evidence() {
    let thread_id = ThreadId::new();
    let mut history = vec![marker(
        thread_id,
        "terminal-after-noise",
        HASH_A,
        "target-turn",
    )];
    history.extend((0..=MAX_ENTRIES).map(|index| turn_complete(format!("noise-{index}"))));
    history.push(turn_complete("target-turn"));
    let index = UserInputOnceIndex::from_history(&resumed(thread_id, history), thread_id);

    assert_eq!(
        index.lookup("terminal-after-noise", HASH_A),
        Ok(Some(UserInputOnceReceipt {
            turn_id: "target-turn".to_string(),
            state: UserInputOnceState::AdmissionOnly,
            execution_state: UserInputOnceExecutionState::LegacyUnknown,
        }))
    );
}

#[test]
fn duplicate_turn_owners_are_never_restartable() {
    let thread_id = ThreadId::new();
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![
                marker(thread_id, "first-owner", HASH_A, "shared-turn"),
                marker(thread_id, "second-owner", HASH_B, "shared-turn"),
            ],
        ),
        thread_id,
    );

    for (client_id, hash) in [("first-owner", HASH_A), ("second-owner", HASH_B)] {
        assert_eq!(
            index
                .lookup(client_id, hash)
                .map(|receipt| { receipt.map(|receipt| receipt.execution_state) }),
            Ok(Some(UserInputOnceExecutionState::LegacyUnknown))
        );
    }
}

#[test]
fn legacy_and_forked_client_ids_fail_closed() {
    let thread_id = ThreadId::new();
    let parent_id = ThreadId::new();
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![
                user("legacy"),
                legacy_marker(thread_id, "legacy", HASH_A, "late-marker"),
                marker(parent_id, "shared", HASH_A, "parent-turn"),
                user("shared"),
                user("shared"),
                marker(parent_id, "parent-only", HASH_A, "parent-turn"),
                user("parent-only"),
                marker(parent_id, "foreign-marker-only", HASH_A, "parent-turn"),
                marker(parent_id, "foreign-invalid", "short", "bad"),
                user("foreign-invalid"),
            ],
        ),
        thread_id,
    );

    assert_eq!(
        index.lookup("legacy", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("shared", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("parent-only", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("foreign-marker-only", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("foreign-invalid", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );

    let forked = UserInputOnceIndex::from_history(
        &InitialHistory::Forked(vec![
            marker(parent_id, "forked", HASH_A, "parent"),
            user("forked"),
        ]),
        thread_id,
    );
    assert_eq!(
        forked.lookup("forked", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
}

#[test]
fn duplicate_or_malformed_markers_fail_closed_and_bounds_are_enforced() {
    let thread_id = ThreadId::new();
    let long_id = "x".repeat(MAX_CLIENT_ID_BYTES + 1);
    let mut future = marker(thread_id, "future", HASH_A, "future");
    let RolloutItem::UserInputOnceMarker(future_marker) = &mut future else {
        unreachable!()
    };
    future_marker.version = MARKER_VERSION + 1;
    let index = UserInputOnceIndex::from_history(
        &resumed(
            thread_id,
            vec![
                marker(thread_id, "duplicate", HASH_A, "first"),
                marker(thread_id, "duplicate", HASH_B, "second"),
                marker(thread_id, "duplicate", "short", "malformed-third"),
                marker(thread_id, &long_id, HASH_A, "long"),
                marker(thread_id, "long-turn", HASH_A, &long_id),
                marker(thread_id, "bad-hash", "short", "bad"),
                future,
            ],
        ),
        thread_id,
    );

    assert_eq!(
        index.lookup("duplicate", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("duplicate", HASH_B),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(index.lookup(&long_id, HASH_A), Ok(None));
    assert_eq!(
        index.lookup("long-turn", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("bad-hash", "short"),
        Err(UserInputOnceLookupError::Legacy)
    );
    assert_eq!(
        index.lookup("future", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
    let mut regular = UserInputOnceIndex::default();
    assert!(regular.reserve_legacy("regular".to_string()));
    assert!(!regular.reserve_legacy("regular".to_string()));
    assert_eq!(
        regular.lookup("regular", HASH_A),
        Err(UserInputOnceLookupError::Legacy)
    );
}
