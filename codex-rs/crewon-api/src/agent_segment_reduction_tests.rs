use pretty_assertions::assert_eq;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    initial_provider_turn_state: String,
    trace: Vec<Event>,
    expected: Expected,
    invalid: Invalid,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    sequence: u64,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    delta: String,
    #[serde(default)]
    discarded_output: bool,
    provider_turn_state: Option<String>,
    output: Option<String>,
    completed_assistant_items: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Expected {
    output: String,
    last_sequence: u64,
    checkpoint_sequence: u64,
    provider_turn_state: String,
    requested_tool_sequences: Vec<u64>,
    continuation_sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Invalid {
    duplicate_checkpoint_error: String,
    output_mismatch_error: String,
    sequence_mismatch_error: String,
}

#[derive(Debug, PartialEq)]
struct Reduction {
    output: String,
    last_sequence: u64,
    checkpoint_sequence: Option<u64>,
    provider_turn_state: Option<String>,
    requested_tool_sequences: Vec<u64>,
    continuation_sequence: Option<u64>,
}

impl Reduction {
    fn new(provider_turn_state: Option<String>) -> Self {
        Self {
            output: String::new(),
            last_sequence: 0,
            checkpoint_sequence: None,
            provider_turn_state,
            requested_tool_sequences: Vec::new(),
            continuation_sequence: None,
        }
    }

    fn accept(&mut self, event: &Event) -> Result<(), &'static str> {
        if event.sequence != self.last_sequence + 1 {
            return Err("segment_sequence_mismatch");
        }
        self.last_sequence = event.sequence;
        match event.kind.as_str() {
            "provider_response_created" => {}
            "output_delta" => self.output.push_str(&event.delta),
            "transport_fallback" if event.discarded_output => self.output.clear(),
            "transport_fallback" => {}
            "checkpointed" => {
                if self.checkpoint_sequence.replace(event.sequence).is_some() {
                    return Err("segment_checkpoint_duplicate");
                }
            }
            "tool_requested" => {
                self.requested_tool_sequences.push(event.sequence);
                if let Some(value) = &event.provider_turn_state {
                    self.provider_turn_state = Some(value.clone());
                }
            }
            "continuation_requested" => {
                if event
                    .completed_assistant_items
                    .as_deref()
                    .unwrap_or_default()
                    .concat()
                    != event.output.as_deref().unwrap_or_default()
                {
                    return Err("segment_output_mismatch");
                }
                self.continuation_sequence = Some(event.sequence);
            }
            "completed" if event.output.as_deref().unwrap_or_default() != self.output => {
                return Err("segment_output_mismatch");
            }
            "completed" => {}
            _ => return Err("segment_event_unknown"),
        }
        Ok(())
    }
}

fn reference() -> Reference {
    let path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/agent-segment-reduction.reference.json"
    )
    .expect("agent segment reduction fixture");
    serde_json::from_slice(&std::fs::read(path).expect("read fixture")).expect("parse fixture")
}

#[test]
fn matches_the_shared_provider_neutral_segment_trace() {
    let reference = reference();
    let mut reduction = Reduction::new(Some(reference.initial_provider_turn_state));
    for event in &reference.trace {
        reduction.accept(event).expect("valid shared trace");
    }
    assert_eq!(
        Expected {
            output: reduction.output,
            last_sequence: reduction.last_sequence,
            checkpoint_sequence: reduction.checkpoint_sequence.expect("checkpoint"),
            provider_turn_state: reduction.provider_turn_state.expect("turn state"),
            requested_tool_sequences: reduction.requested_tool_sequences,
            continuation_sequence: reduction.continuation_sequence.expect("continuation"),
        },
        reference.expected
    );
}

#[test]
fn shared_fail_closed_errors_cover_duplicates_and_mismatches() {
    let reference = reference();
    let checkpoint = Event {
        sequence: 1,
        kind: "checkpointed".into(),
        ..reference.trace[0].clone()
    };
    let mut duplicate = Reduction::new(None);
    duplicate.accept(&checkpoint).expect("first checkpoint");
    let mut second = checkpoint.clone();
    second.sequence = 2;
    assert_eq!(
        duplicate.accept(&second).expect_err("duplicate checkpoint"),
        reference.invalid.duplicate_checkpoint_error
    );

    let mut output = Reduction::new(None);
    let completed = Event {
        sequence: 1,
        kind: "completed".into(),
        output: Some("forged".into()),
        ..reference.trace[0].clone()
    };
    assert_eq!(
        output.accept(&completed).expect_err("output mismatch"),
        reference.invalid.output_mismatch_error
    );

    let mut sequence = Reduction::new(None);
    let gap = Event {
        sequence: 2,
        kind: "output_delta".into(),
        delta: "gap".into(),
        ..reference.trace[0].clone()
    };
    assert_eq!(
        sequence.accept(&gap).expect_err("sequence mismatch"),
        reference.invalid.sequence_mismatch_error
    );
}
