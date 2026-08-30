use super::*;
use pretty_assertions::assert_eq;

#[test]
fn classifies_status_questions_and_acknowledgements_as_conversation() {
    for text in [
        "开始执行了吗？",
        "现在进度怎么样",
        "为什么还在等待？",
        "收到，谢谢",
        "What is the current status?",
    ] {
        assert_eq!(
            OfficeMessageIntent::classify(text, /*has_mentions*/ false),
            OfficeMessageIntent::Conversation,
            "{text}"
        );
    }
}

#[test]
fn keeps_explicit_action_requests_as_tasks() {
    for text in [
        "请实现登录页",
        "能帮我修复这个 bug 吗？",
        "继续执行并补齐测试",
        "Can you implement the new flow?",
        "更新进度页面",
        "Design a status dashboard",
        "Can you check?",
        "look into the outage",
    ] {
        assert_eq!(
            OfficeMessageIntent::classify(text, /*has_mentions*/ false),
            OfficeMessageIntent::Task,
            "{text}"
        );
    }
}

#[test]
fn persists_versioned_intent_on_canonical_messages() {
    let message = serde_json::json!({
        "officeMessageReceipt": {
            "messageIntent": "conversation",
            "intentClassifierVersion": 1
        }
    });
    assert_eq!(
        OfficeMessageIntent::from_message(&message),
        Some(OfficeMessageIntent::Conversation)
    );

    let legacy = serde_json::json!({ "officeMessageReceipt": {} });
    assert_eq!(OfficeMessageIntent::from_message(&legacy), None);
}
