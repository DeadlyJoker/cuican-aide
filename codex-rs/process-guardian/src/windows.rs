use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPTHREAD;
use windows_sys::Win32::System::Diagnostics::ToolHelp::THREADENTRY32;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Thread32First;
use windows_sys::Win32::System::Diagnostics::ToolHelp::Thread32Next;
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use windows_sys::Win32::System::JobObjects::JobObjectBasicAccountingInformation;
use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
use windows_sys::Win32::System::Threading::GetProcessId;
use windows_sys::Win32::System::Threading::OpenThread;
use windows_sys::Win32::System::Threading::ResumeThread;
use windows_sys::Win32::System::Threading::THREAD_SUSPEND_RESUME;

use crate::GuardianError;
use crate::GuardianFailure;
use crate::TargetSpec;

const JOB_EMPTY_POLL: Duration = Duration::from_millis(10);
const JOB_EMPTY_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct ContainedChild {
    target: Child,
    job: OwnedJob,
}

struct OwnedJob(HANDLE);

impl Drop for OwnedJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

impl ContainedChild {
    pub(crate) fn spawn(target: &TargetSpec) -> Result<Self, GuardianFailure> {
        let job = create_kill_on_close_job().map_err(GuardianFailure::cleanup_proven)?;
        let mut command = Command::new(&target.program);
        command
            .args(&target.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let child = command
            .spawn()
            .map_err(|_| GuardianFailure::cleanup_proven(GuardianError::TargetSpawnFailed))?;
        let process_handle = child.as_raw_handle() as HANDLE;
        if unsafe { AssignProcessToJobObject(job.0, process_handle) } == 0 {
            return Err(cleanup_unassigned_suspended_child(child));
        }
        if resume_process_threads(process_handle).is_err() {
            return Err(cleanup_assigned_suspended_child(job, child));
        }
        Ok(Self { target: child, job })
    }

    pub(crate) fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.target.stdin.take()
    }

    pub(crate) fn try_wait(&mut self) -> Result<Option<ExitStatus>, GuardianError> {
        self.target
            .try_wait()
            .map_err(|_| GuardianError::WaitFailed)
    }

    pub(crate) fn terminate(
        &mut self,
        _graceful_timeout: Duration,
    ) -> Result<ExitStatus, GuardianError> {
        if unsafe { TerminateJobObject(self.job.0, 1) } == 0 {
            return Err(GuardianError::ContainmentFailed);
        }
        let status = self.target.wait().map_err(|_| GuardianError::WaitFailed)?;
        wait_for_empty_job(self.job.0)?;
        Ok(status)
    }
}

fn cleanup_unassigned_suspended_child(mut child: Child) -> GuardianFailure {
    if child.kill().is_ok() && child.wait().is_ok() {
        GuardianFailure::cleanup_proven(GuardianError::ContainmentFailed)
    } else {
        GuardianFailure::cleanup_unproven(GuardianError::ContainmentFailed)
    }
}

fn cleanup_assigned_suspended_child(job: OwnedJob, mut child: Child) -> GuardianFailure {
    let terminated = unsafe { TerminateJobObject(job.0, 1) } != 0;
    let waited = child.wait().is_ok();
    let empty = wait_for_empty_job(job.0).is_ok();
    if terminated && waited && empty {
        GuardianFailure::cleanup_proven(GuardianError::ContainmentFailed)
    } else {
        GuardianFailure::cleanup_unproven(GuardianError::ContainmentFailed)
    }
}

fn create_kill_on_close_job() -> Result<OwnedJob, GuardianError> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(GuardianError::ContainmentFailed);
    }
    let job = OwnedJob(handle);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let applied = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            u32::try_from(std::mem::size_of_val(&limits))
                .map_err(|_| GuardianError::ContainmentFailed)?,
        )
    };
    if applied == 0 {
        return Err(GuardianError::ContainmentFailed);
    }
    Ok(job)
}

fn resume_process_threads(process_handle: HANDLE) -> Result<(), GuardianError> {
    let process_id = unsafe { GetProcessId(process_handle) };
    if process_id == 0 {
        return Err(GuardianError::ContainmentFailed);
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(GuardianError::ContainmentFailed);
    }
    let snapshot = OwnedHandle(snapshot);
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(std::mem::size_of::<THREADENTRY32>())
            .map_err(|_| GuardianError::ContainmentFailed)?,
        ..Default::default()
    };
    let mut found = false;
    let mut current = unsafe { Thread32First(snapshot.0, &mut entry) };
    while current != 0 {
        if entry.th32OwnerProcessID == process_id {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(GuardianError::ContainmentFailed);
            }
            let thread = OwnedHandle(thread);
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(GuardianError::ContainmentFailed);
            }
            found = true;
        }
        current = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    found.then_some(()).ok_or(GuardianError::ContainmentFailed)
}

fn wait_for_empty_job(job: HANDLE) -> Result<(), GuardianError> {
    let deadline = Instant::now() + JOB_EMPTY_TIMEOUT;
    loop {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast(),
                u32::try_from(std::mem::size_of_val(&accounting))
                    .map_err(|_| GuardianError::ContainmentFailed)?,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(GuardianError::ContainmentFailed);
        }
        if accounting.ActiveProcesses == 0 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(GuardianError::WaitFailed);
        }
        std::thread::sleep(JOB_EMPTY_POLL);
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
