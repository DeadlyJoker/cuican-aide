use serde_json::Value as JsonValue;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeMessageIntent {
    Conversation,
    Task,
}

impl OfficeMessageIntent {
    pub(crate) const CLASSIFIER_VERSION: u64 = 1;

    pub(crate) fn classify(text: &str, has_mentions: bool) -> Self {
        let normalized = text.trim().to_lowercase();
        if normalized.is_empty() {
            return Self::Task;
        }

        let question_mark = normalized.ends_with('?') || normalized.ends_with('？');
        let question = question_mark
            || contains_any(
                &normalized,
                &[
                    "为什么",
                    "是什么",
                    "怎么样",
                    "进度",
                    "到哪了",
                    "在吗",
                    "收到吗",
                    "是否",
                    "有没有",
                    "how ",
                    "what ",
                    "why ",
                    "status",
                    "progress",
                    "are you",
                    "did you",
                ],
            );
        let action = contains_any(
            &normalized,
            &[
                "实现",
                "修复",
                "创建",
                "执行",
                "运行",
                "测试",
                "生成",
                "整理",
                "撰写",
                "更新",
                "删除",
                "部署",
                "发布",
                "设计",
                "开发",
                "调查",
                "分析",
                "审阅",
                "检查",
                "补齐",
                "改一下",
                "看一下",
                "implement",
                "fix",
                "create ",
                "run ",
                "test ",
                "generate",
                "write ",
                "update ",
                "delete ",
                "deploy",
                "publish",
                "design ",
                "build ",
                "review ",
                "check",
            ],
        );
        let explicit_request = contains_any(
            &normalized,
            &[
                "请",
                "帮我",
                "麻烦",
                "需要你",
                "让你",
                "把",
                "继续",
                "please",
                "can you",
                "could you",
                "i need you",
                "go ahead",
                "continue",
            ],
        );
        if action && (explicit_request || !question_mark) {
            return Self::Task;
        }
        if question {
            return Self::Conversation;
        }
        let short_english_ack = matches!(
            normalized.as_str(),
            "hello" | "hi" | "thanks" | "thank you" | "got it" | "okay" | "ok"
        );
        if (short_english_ack
            || contains_any(
                &normalized,
                &["你好", "您好", "谢谢", "收到", "好的", "明白", "辛苦了"],
            ))
            && (!has_mentions || normalized.chars().count() <= 80)
        {
            return Self::Conversation;
        }
        Self::Task
    }

    pub(crate) fn from_run(run: &JsonValue) -> Self {
        match run.get("messageIntent").and_then(JsonValue::as_str) {
            Some("conversation") => Self::Conversation,
            Some("task") | None | Some(_) => Self::Task,
        }
    }

    pub(crate) fn from_message(message: &JsonValue) -> Option<Self> {
        let receipt = message.get("officeMessageReceipt")?;
        if receipt
            .get("intentClassifierVersion")
            .and_then(JsonValue::as_u64)
            != Some(Self::CLASSIFIER_VERSION)
        {
            return None;
        }
        match receipt.get("messageIntent").and_then(JsonValue::as_str) {
            Some("conversation") => Some(Self::Conversation),
            Some("task") => Some(Self::Task),
            None | Some(_) => None,
        }
    }

    pub(crate) fn from_canonical_message(
        config: &JsonValue,
        client_user_message_id: &str,
    ) -> Option<Self> {
        config
            .get("workspace")?
            .get("messages")?
            .as_array()?
            .iter()
            .find(|message| {
                message
                    .get("officeMessageReceipt")
                    .and_then(|receipt| receipt.get("clientUserMessageId"))
                    .and_then(JsonValue::as_str)
                    == Some(client_user_message_id)
            })
            .and_then(Self::from_message)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Task => "task",
        }
    }
}

fn contains_any(value: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| value.contains(pattern))
}

#[cfg(test)]
#[path = "crewon_domain_office_message_intent_tests.rs"]
mod tests;
