use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::UserInputOnceMarker;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;

use super::user_input_once_index::MARKER_VERSION;
use super::user_input_once_index::valid_execution_fence;
use super::user_input_once_index::valid_marker;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DurableAdmissionMatch {
    Exact,
    Absent,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DurableExecutionFenceMatch {
    Exact,
    Absent,
    Ambiguous,
}

pub(super) fn classify_durable_admission(
    items: &[RolloutItem],
    expected: &UserInputOnceMarker,
) -> DurableAdmissionMatch {
    let mut matched = DurableAdmissionMatch::Absent;
    for item in items {
        match item {
            RolloutItem::UserInputOnceMarker(marker) if marker.client_id == expected.client_id => {
                if marker.phase == UserInputOnceMarkerPhase::Admission
                    && valid_marker(marker)
                    && marker == expected
                    && matched == DurableAdmissionMatch::Absent
                {
                    matched = DurableAdmissionMatch::Exact;
                } else {
                    return DurableAdmissionMatch::Ambiguous;
                }
            }
            RolloutItem::EventMsg(EventMsg::UserMessage(event))
                if event.client_id.as_deref() == Some(expected.client_id.as_str()) =>
            {
                return DurableAdmissionMatch::Ambiguous;
            }
            _ => {}
        }
    }
    matched
}

pub(super) fn classify_durable_execution_fence(
    items: &[RolloutItem],
    expected: &UserInputOnceMarker,
) -> DurableExecutionFenceMatch {
    let mut saw_admission = false;
    let mut matched = DurableExecutionFenceMatch::Absent;
    for item in items {
        match item {
            RolloutItem::UserInputOnceMarker(marker) if marker.client_id == expected.client_id => {
                match marker.phase {
                    UserInputOnceMarkerPhase::Admission
                        if !saw_admission
                            && valid_marker(marker)
                            && marker.version == MARKER_VERSION
                            && marker.thread_id == expected.thread_id
                            && marker.payload_hash == expected.payload_hash
                            && marker.turn_id == expected.turn_id =>
                    {
                        saw_admission = true;
                    }
                    UserInputOnceMarkerPhase::ExecutionFence
                        if saw_admission
                            && matched == DurableExecutionFenceMatch::Absent
                            && valid_execution_fence(marker)
                            && marker == expected =>
                    {
                        matched = DurableExecutionFenceMatch::Exact;
                    }
                    _ => return DurableExecutionFenceMatch::Ambiguous,
                }
            }
            RolloutItem::EventMsg(EventMsg::UserMessage(event))
                if event.client_id.as_deref() == Some(expected.client_id.as_str()) =>
            {
                return DurableExecutionFenceMatch::Ambiguous;
            }
            RolloutItem::EventMsg(EventMsg::TurnStarted(event))
                if event.turn_id == expected.turn_id =>
            {
                return DurableExecutionFenceMatch::Ambiguous;
            }
            RolloutItem::EventMsg(EventMsg::TurnComplete(event))
                if event.turn_id == expected.turn_id =>
            {
                return DurableExecutionFenceMatch::Ambiguous;
            }
            RolloutItem::EventMsg(EventMsg::TurnAborted(event))
                if event.turn_id.as_deref() == Some(expected.turn_id.as_str()) =>
            {
                return DurableExecutionFenceMatch::Ambiguous;
            }
            _ => {}
        }
    }
    if saw_admission {
        matched
    } else {
        DurableExecutionFenceMatch::Ambiguous
    }
}
