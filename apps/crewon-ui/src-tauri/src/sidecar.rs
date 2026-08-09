//! Supervises the bundled `crewon-app-server` process.
//!
//! A packaged desktop build ships the backend as a Tauri sidecar rather than
//! expecting a developer to start it by hand. The shell owns its lifetime so the
//! backend cannot outlive the window (the manual `nohup` workflow routinely left
//! orphans) and cannot silently vanish while the UI waits on a socket.

use std::net::TcpStream;
use std::net::ToSocketAddrs;
use std::time::Duration;
use std::time::Instant;

use tauri::AppHandle;
use tauri::Manager;
use tauri::RunEvent;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Loopback port the frontend dials in a packaged build. Keep in sync with
/// `DEFAULT_APP_SERVER_PORT` in `src/lib/platform.ts`.
const APP_SERVER_PORT: u16 = 6176;

/// Set when the frontend should talk to an app-server the developer runs
/// themselves; `tauri dev` uses this so the sidecar does not fight for the port.
const SKIP_SIDECAR_ENV: &str = "CREWON_DESKTOP_SKIP_SIDECAR";

/// Tracks the child so the exit handler can reap it.
pub struct AppServerSidecar {
    child: std::sync::Mutex<Option<CommandChild>>,
}

impl AppServerSidecar {
    fn new(child: CommandChild) -> Self {
        Self {
            child: std::sync::Mutex::new(Some(child)),
        }
    }

    /// Terminates the backend. Safe to call more than once: the window can close
    /// before `RunEvent::Exit`, and both paths reap.
    pub fn shutdown(&self) {
        let Ok(mut guard) = self.child.lock() else {
            return;
        };
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

/// Whether something already serves the app-server port.
///
/// Reconnecting to a healthy backend beats failing to bind and leaving the UI on
/// a dead socket, which is what the manual workflow did when a stale process
/// still held the port.
fn port_in_use(port: u16) -> bool {
    let Ok(mut addrs) = ("127.0.0.1", port).to_socket_addrs() else {
        return false;
    };
    addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok())
}

/// Blocks until the backend accepts connections, so the webview does not dial a
/// port that is not listening yet.
fn wait_until_listening(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if port_in_use(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Starts the bundled backend unless one is already running.
pub fn spawn(app: &AppHandle) -> Result<(), tauri_plugin_shell::Error> {
    if std::env::var(SKIP_SIDECAR_ENV).is_ok_and(|value| !value.is_empty()) {
        return Ok(());
    }

    if port_in_use(APP_SERVER_PORT) {
        // A developer's own app-server, or one left by a previous run. Either way
        // the frontend can use it, and binding a second would only fail.
        return Ok(());
    }

    let (_rx, child) = app
        .shell()
        .sidecar("crewon-app-server")?
        .args(["--listen", &format!("ws://127.0.0.1:{APP_SERVER_PORT}")])
        .spawn()?;

    app.manage(AppServerSidecar::new(child));

    // Bounded: the UI shows its own connection state, so a slow backend should not
    // hold the window closed indefinitely.
    wait_until_listening(APP_SERVER_PORT, Duration::from_secs(20));

    Ok(())
}

/// Reaps the backend when the app exits, on every platform.
///
/// Windows does not deliver POSIX signals, so relying on the child noticing its
/// parent left is not portable -- the shell has to kill it explicitly.
pub fn handle_run_event(app: &AppHandle, event: RunEvent) {
    if matches!(event, RunEvent::Exit) {
        if let Some(sidecar) = app.try_state::<AppServerSidecar>() {
            sidecar.shutdown();
        }
    }
}
