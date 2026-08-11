fn main() {
    match crewon_process_guardian::run_from_process() {
        Ok(code) => std::process::exit(code),
        Err(failure) => {
            eprintln!("{}", failure.code());
            std::process::exit(failure.exit_code());
        }
    }
}
