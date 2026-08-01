use crate::state::ActiveTurn;
use crate::state::TurnState;
use std::sync::Arc;
use tokio::sync::Mutex;
pub(super) enum TaskStartReservation {
    Unreserved,
    Exact(Arc<Mutex<TurnState>>),
}
impl TaskStartReservation {
    pub(super) fn is_exact(&self) -> bool {
        matches!(self, Self::Exact(_))
    }
    pub(super) fn resolve<'a>(
        &self,
        active: &'a mut Option<ActiveTurn>,
    ) -> Option<&'a mut ActiveTurn> {
        match self {
            Self::Unreserved => {
                let turn = active.get_or_insert_with(ActiveTurn::default);
                debug_assert!(turn.task.is_none());
                Some(turn)
            }
            Self::Exact(expected) => active
                .as_mut()
                .filter(|turn| turn.task.is_none() && Arc::ptr_eq(&turn.turn_state, expected)),
        }
    }
}
