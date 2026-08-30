#[tokio::main]
async fn main() {
    if std::env::args_os().len() != 1 {
        std::process::exit(2);
    }
    if crewon_device_runtime::run_from_stdin_with_ready(|ready| {
        let line = ready.supervisor_line();
        println!("{line}");
    })
    .await
    .is_err()
    {
        std::process::exit(1);
    }
}
