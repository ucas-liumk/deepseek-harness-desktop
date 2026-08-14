use std::{
    error::Error,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
use std::collections::{HashMap, VecDeque};

use tauri::{Manager, RunEvent, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[cfg(test)]
use tauri::webview::PageLoadEvent;

#[cfg(target_os = "macos")]
use tauri::webview::DownloadEvent;

#[cfg(unix)]
use std::os::unix::process::CommandExt as UnixCommandExt;

#[cfg(windows)]
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt as WindowsCommandExt,
};

#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const MAIN_WINDOW: &str = "main";
const APP_TITLE: &str = "Unofficial DeepSeek Harness Desktop";
const SIDECAR_NAME: &str = "dsh-backend";
const SMOKE_READY_FILE_ENV: &str = "DSH_DESKTOP_SMOKE_READY_FILE";
const DESKTOP_API_TOKEN_ENV: &str = "DSH_DESKTOP_API_TOKEN";
const DESKTOP_READY_TITLE_PREFIX: &str = "dsh-desktop-auth-ready-";
const READY_PREFIX: &str = "dsh web: ";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1_500);
const FORCED_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1_500);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const MAX_DIAGNOSTIC_EVENTS: usize = 8;
const MAX_DIAGNOSTIC_BYTES: usize = 500;
#[cfg(target_os = "macos")]
const DESKTOP_DOWNLOAD_EVENT: &str = "dsh:desktop-download";
#[cfg(target_os = "macos")]
const MACOS_PLATFORM_INITIALIZATION_SCRIPT: &str =
    "Object.defineProperty(globalThis,'__DSH_DESKTOP_PLATFORM__',{value:'macos',writable:false,configurable:false});";

fn generate_desktop_random_hex() -> io::Result<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| io::Error::other("operating-system randomness unavailable"))?;
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(char::from(HEX[usize::from(byte >> 4)]));
        value.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(value)
}

fn generate_desktop_api_token() -> io::Result<String> {
    generate_desktop_random_hex()
}

fn generate_desktop_ready_title() -> io::Result<String> {
    Ok(format!(
        "{DESKTOP_READY_TITLE_PREFIX}{}",
        generate_desktop_random_hex()?
    ))
}

fn desktop_auth_initialization_script(token: &str, ready_title: &str) -> String {
    let token = serde_json::to_string(token).expect("desktop API token is JSON serializable");
    let ready_title = serde_json::to_string(ready_title)
        .expect("desktop authenticated-ready title is JSON serializable");
    format!(
        r#"(() => {{
          if (window.top !== window
              || location.protocol !== 'http:'
              || location.hostname !== '127.0.0.1'
              || location.port === ''
              || location.origin !== 'http://127.0.0.1:' + location.port) return;
          Object.defineProperty(globalThis, '__DSH_DESKTOP_API_AUTH__', {{
            value: true,
            writable: false,
            configurable: false,
          }});
          const desktopToken = {token};
          const desktopReadyTitle = {ready_title};
          const isDesktopApiPath = path => path === '/api' || path.startsWith('/api/');
          const NativeHeaders = globalThis.Headers;
          const NativeRequest = globalThis.Request;
          const NativeURL = globalThis.URL;
          const nativeFetch = globalThis.fetch.bind(globalThis);
          let desktopReadySignalled = false;
          globalThis.fetch = async (input, init) => {{
            let requestUrl;
            try {{
              requestUrl = new NativeURL(
                input instanceof NativeRequest ? input.url : String(input),
                location.href,
              );
            }} catch {{
              return nativeFetch(input, init);
            }}
            if (requestUrl.origin !== location.origin || !isDesktopApiPath(requestUrl.pathname)) {{
              return nativeFetch(input, init);
            }}
            const request = new NativeRequest(input, init);
            const headers = new NativeHeaders(request.headers);
            headers.set('Authorization', 'Bearer ' + desktopToken);
            const response = await nativeFetch(new NativeRequest(request, {{ headers }}));
            if (!desktopReadySignalled && response.ok) {{
              desktopReadySignalled = true;
              document.title = desktopReadyTitle;
            }}
            return response;
          }};

          const NativeWebSocket = globalThis.WebSocket;
          globalThis.WebSocket = new Proxy(NativeWebSocket, {{
            construct(Target, args, NewTarget) {{
              let socketUrl;
              try {{
                socketUrl = new NativeURL(String(args[0]), location.href);
              }} catch {{
                return Reflect.construct(Target, args, NewTarget);
              }}
              const isDesktopEventSocket = (socketUrl.protocol === 'ws:'
                  || socketUrl.protocol === location.protocol)
                && socketUrl.username === ''
                && socketUrl.password === ''
                && socketUrl.host === location.host
                && socketUrl.search === ''
                && socketUrl.hash === ''
                && (socketUrl.pathname === '/api/events.mux'
                  || socketUrl.pathname === '/api/events.host');
              if (!isDesktopEventSocket) return Reflect.construct(Target, args, NewTarget);
              return Reflect.construct(
                Target,
                [args[0], ['dsh-v1', 'dsh-auth-' + desktopToken]],
                NewTarget,
              );
            }},
          }});
        }})();"#
    )
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct DesktopDownloads {
    pending_filenames: Mutex<HashMap<String, VecDeque<String>>>,
}

#[cfg(target_os = "macos")]
impl DesktopDownloads {
    fn record(&self, url: &Url, destination: &Path) -> bool {
        let filename = destination
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("dsh-session.zip")
            .to_owned();
        let Ok(mut pending) = self.pending_filenames.lock() else {
            return false;
        };
        pending
            .entry(url.as_str().to_owned())
            .or_default()
            .push_back(filename);
        true
    }

    fn finish(&self, url: &Url) -> Option<String> {
        let Ok(mut pending) = self.pending_filenames.lock() else {
            return None;
        };
        let key = url.as_str();
        let filenames = pending.get_mut(key)?;
        let filename = filenames.pop_front();
        if filenames.is_empty() {
            pending.remove(key);
        }
        filename
    }
}

const PENDING: u8 = 0;
const NAVIGATING: u8 = 1;
const READY: u8 = 2;
const FAILED: u8 = 3;
const STOPPING: u8 = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartupStage {
    AppDataResolution,
    AppDataPreparation,
    RuntimeLocation,
    RuntimeLaunch,
    ReadinessTimeout,
    ReadinessValidation,
    RuntimeNavigation,
    SmokeReadySignal,
    RuntimeIo,
    RuntimeExit,
    OutputChannel,
}

impl StartupStage {
    const fn code(self) -> &'static str {
        match self {
            Self::AppDataResolution => "app-data-resolution",
            Self::AppDataPreparation => "app-data-preparation",
            Self::RuntimeLocation => "runtime-location",
            Self::RuntimeLaunch => "runtime-launch",
            Self::ReadinessTimeout => "readiness-timeout",
            Self::ReadinessValidation => "readiness-validation",
            Self::RuntimeNavigation => "runtime-navigation",
            Self::SmokeReadySignal => "smoke-ready-signal",
            Self::RuntimeIo => "runtime-io",
            Self::RuntimeExit => "runtime-exit",
            Self::OutputChannel => "output-channel",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct DiagnosticSummary {
    events: usize,
    bytes: usize,
    truncated: bool,
}

impl DiagnosticSummary {
    fn observe(&mut self, bytes: &[u8]) {
        if self.events == MAX_DIAGNOSTIC_EVENTS {
            self.truncated = true;
            return;
        }
        self.events += 1;
        let remaining = MAX_DIAGNOSTIC_BYTES.saturating_sub(self.bytes);
        self.bytes += bytes.len().min(remaining);
        if bytes.len() > remaining {
            self.truncated = true;
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StartupFailure {
    stage: StartupStage,
    exit_code: Option<i32>,
    diagnostics: DiagnosticSummary,
}

impl StartupFailure {
    const fn at(stage: StartupStage) -> Self {
        Self {
            stage,
            exit_code: None,
            diagnostics: DiagnosticSummary {
                events: 0,
                bytes: 0,
                truncated: false,
            },
        }
    }

    const fn with_exit_code(mut self, exit_code: Option<i32>) -> Self {
        self.exit_code = exit_code;
        self
    }

    const fn with_diagnostics(mut self, diagnostics: DiagnosticSummary) -> Self {
        self.diagnostics = diagnostics;
        self
    }

    fn message(self) -> String {
        let mut message = format!("Desktop startup failed (stage: {}).", self.stage.code());
        if let Some(exit_code) = self.exit_code {
            message.push_str(&format!(" Exit code: {exit_code}."));
        }
        if self.diagnostics.events != 0 {
            message.push_str(&format!(
                " Diagnostics: {} event(s), {} byte(s){}.",
                self.diagnostics.events,
                self.diagnostics.bytes,
                if self.diagnostics.truncated {
                    ", truncated"
                } else {
                    ""
                }
            ));
        }
        message
    }
}

#[derive(Default)]
struct NavigationPolicy {
    runtime_port: Mutex<Option<u16>>,
}

impl NavigationPolicy {
    fn activate_runtime(&self, url: &Url) -> Result<(), ()> {
        let port = trusted_runtime_port(url).ok_or(())?;
        *self.runtime_port.lock().map_err(|_| ())? = Some(port);
        Ok(())
    }

    fn allows(&self, url: &Url) -> bool {
        let Ok(runtime_port) = self.runtime_port.lock() else {
            return false;
        };
        navigation_allowed(url, *runtime_port)
    }

    fn runtime_port(&self) -> Option<u16> {
        self.runtime_port.lock().ok().and_then(|port| *port)
    }
}

struct ManagedProcess {
    pid: u32,
    child: Option<Child>,
    tree: ProcessTree,
}

#[cfg(not(windows))]
struct ProcessTree;

#[cfg(not(windows))]
impl ProcessTree {
    fn new() -> io::Result<Self> {
        Ok(Self)
    }

    fn assign(&self, _child: &Child) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(windows)]
struct ProcessTree {
    job: OwnedHandle,
}

#[cfg(windows)]
impl ProcessTree {
    fn new() -> io::Result<Self> {
        // SAFETY: both pointer arguments are null, requesting an unnamed job
        // with the caller's default security descriptor.
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateJobObjectW returned a new owned HANDLE on success.
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let limits_size = u32::try_from(std::mem::size_of_val(&limits))
            .map_err(|_| io::Error::other("Windows job limits structure is too large"))?;
        // SAFETY: job is a live job-object handle and the pointer/length pair
        // addresses a fully initialized JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                limits_size,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { job })
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        // SAFETY: both handles are live for this call. The child is assigned
        // before its stdout is consumed or the backend can be considered ready.
        if unsafe { AssignProcessToJobObject(self.job.as_raw_handle(), child.as_raw_handle()) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn active_process_count(&self) -> io::Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let accounting_size = u32::try_from(std::mem::size_of_val(&accounting))
            .map_err(|_| io::Error::other("Windows job accounting structure is too large"))?;
        // SAFETY: job is live and the mutable pointer/length pair addresses a
        // correctly sized JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value.
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut accounting).cast(),
                accounting_size,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }

    fn terminate(&self) {
        // SAFETY: job remains owned by this ProcessTree. Terminating an empty
        // job is harmless; closing the final handle is the fallback guarantee.
        let _ = unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) };
    }
}

enum ChildPoll {
    Running,
    Exited(ExitStatus),
    AlreadyReaped,
}

struct BackendState {
    phase: AtomicU8,
    process: Mutex<ManagedProcess>,
    stop_serial: Mutex<()>,
    termination_quiet: AtomicBool,
}

impl BackendState {
    fn new(child: Child, tree: ProcessTree) -> Self {
        Self {
            phase: AtomicU8::new(PENDING),
            process: Mutex::new(ManagedProcess {
                pid: child.id(),
                child: Some(child),
                tree,
            }),
            stop_serial: Mutex::new(()),
            termination_quiet: AtomicBool::new(false),
        }
    }

    fn poll_child(&self) -> io::Result<ChildPoll> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| io::Error::other("backend process lock poisoned"))?;
        let Some(child) = process.child.as_mut() else {
            return Ok(ChildPoll::AlreadyReaped);
        };
        let Some(status) = child.try_wait()? else {
            return Ok(ChildPoll::Running);
        };
        process.child.take();
        Ok(ChildPoll::Exited(status))
    }

    fn wait_until_quiet(process: &mut ManagedProcess, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if process
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
                .is_some()
            {
                process.child.take();
            }
            let tree_active =
                termination_target_exists(process.pid, process.child.is_some(), &process.tree);
            if !tree_active && process.child.is_none() {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            thread::sleep(remaining.min(PROCESS_POLL_INTERVAL));
        }
    }

    fn stop(&self) -> bool {
        let Ok(_stop_guard) = self.stop_serial.lock() else {
            return false;
        };
        if self.phase.swap(STOPPING, Ordering::SeqCst) == STOPPING {
            return self.termination_quiet.load(Ordering::SeqCst);
        }
        let Ok(mut process) = self.process.lock() else {
            return false;
        };
        let pid = process.pid;

        graceful_terminate(pid, &process.tree);
        if Self::wait_until_quiet(&mut process, GRACEFUL_SHUTDOWN_TIMEOUT) {
            self.termination_quiet.store(true, Ordering::SeqCst);
            return true;
        }

        force_terminate(pid, &process.tree);
        if let Some(child) = process.child.as_mut() {
            let _ = child.kill();
        }
        let quiet = Self::wait_until_quiet(&mut process, FORCED_SHUTDOWN_TIMEOUT);
        self.termination_quiet.store(quiet, Ordering::SeqCst);
        quiet
    }

    fn stop_in_background(self: &Arc<Self>) {
        let state = self.clone();
        thread::spawn(move || {
            state.stop();
        });
    }
}

#[derive(Clone, Copy, Debug)]
struct TerminatedPayload {
    code: Option<i32>,
}

enum BackendEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Error,
    Terminated(TerminatedPayload),
}

#[cfg(any(windows, test))]
fn job_has_termination_target(active_processes: Result<u32, ()>) -> bool {
    match active_processes {
        Ok(count) => count != 0,
        // A failed job query must not turn into permission to leave a process
        // tree running. The stop path will wait its bounded grace period and
        // then terminate the job.
        Err(()) => true,
    }
}

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "kill"]
    fn send_signal(pid: i32, signal: i32) -> i32;
}

#[cfg(unix)]
fn process_group_target(pid: u32) -> Option<i32> {
    let pid = i32::try_from(pid).ok()?;
    (pid > 0).then(|| -pid)
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: i32) -> bool {
    let Some(target) = process_group_target(pid) else {
        return false;
    };
    // SAFETY: the child is placed in a process group whose id is its positive
    // PID before exec. Negating that validated PID addresses only that group.
    unsafe { send_signal(target, signal) == 0 }
}

#[cfg(unix)]
fn graceful_terminate(pid: u32, _tree: &ProcessTree) {
    const SIGTERM: i32 = 15;
    let _ = signal_process_group(pid, SIGTERM);
}

#[cfg(windows)]
fn graceful_terminate(pid: u32, _tree: &ProcessTree) {
    run_taskkill(pid);
}

#[cfg(unix)]
fn force_terminate(pid: u32, _tree: &ProcessTree) {
    const SIGKILL: i32 = 9;
    let _ = signal_process_group(pid, SIGKILL);
}

#[cfg(windows)]
fn force_terminate(_pid: u32, tree: &ProcessTree) {
    tree.terminate();
}

#[cfg(unix)]
fn termination_target_exists(pid: u32, _child_present: bool, _tree: &ProcessTree) -> bool {
    signal_process_group(pid, 0)
}

#[cfg(windows)]
fn termination_target_exists(_pid: u32, _child_present: bool, tree: &ProcessTree) -> bool {
    job_has_termination_target(tree.active_process_count().map_err(|_| ()))
}

#[cfg(windows)]
fn run_taskkill(pid: u32) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let executable = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("taskkill.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
    let mut command = Command::new(executable);
    command
        .args(["/PID", &pid.to_string(), "/T"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let _ = command.status();
}

fn sidecar_path() -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| io::Error::other("application executable has no parent directory"))?;
    let base_dir = if executable_dir.ends_with("deps") {
        executable_dir.parent().unwrap_or(executable_dir)
    } else {
        executable_dir
    };
    let path = base_dir.join(SIDECAR_NAME);
    #[cfg(windows)]
    {
        let mut path = path;
        path.as_mut_os_string().push(".exe");
        Ok(path)
    }
    #[cfg(not(windows))]
    {
        Ok(path)
    }
}

fn configure_backend_command(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn configure_backend_environment(command: &mut Command, data_dir: &Path, api_token: &str) {
    command
        .env("DSH_HOME", data_dir)
        .env("DSH_CLOSED_RUNTIME", "1")
        .env(DESKTOP_API_TOKEN_ENV, api_token)
        .env("PKG_NATIVE_CACHE_PATH", data_dir.join("native-cache"))
        .env_remove(SMOKE_READY_FILE_ENV);
}

fn spawn_managed_process(command: &mut Command) -> io::Result<(Child, ProcessTree)> {
    let tree = ProcessTree::new()?;
    let mut child = command.spawn()?;
    if let Err(error) = tree.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((child, tree))
}

fn spawn_backend(
    executable: &Path,
    data_dir: &Path,
    api_token: &str,
) -> io::Result<(Child, ChildStdout, ChildStderr, ProcessTree)> {
    let mut command = Command::new(executable);
    command
        .args(["web", "--host", "127.0.0.1", "--port", "0"])
        .current_dir(data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_backend_environment(&mut command, data_dir, api_token);
    configure_backend_command(&mut command);

    let (mut child, tree) = spawn_managed_process(&mut command)?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("backend stdout pipe missing"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("backend stderr pipe missing"));
        }
    };
    Ok((child, stdout, stderr, tree))
}

fn pump_output<R, F>(reader: R, sender: Sender<BackendEvent>, event: F)
where
    R: Read,
    F: Fn(Vec<u8>) -> BackendEvent,
{
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => return,
            Ok(_) => {
                if sender.send(event(line.clone())).is_err() {
                    return;
                }
            }
            Err(_) => {
                let _ = sender.send(BackendEvent::Error);
                return;
            }
        }
    }
}

fn monitor_backend(state: Arc<BackendState>, sender: Sender<BackendEvent>) {
    let mut reported_error = false;
    loop {
        match state.poll_child() {
            Ok(ChildPoll::Running) => thread::sleep(PROCESS_POLL_INTERVAL),
            Ok(ChildPoll::Exited(status)) => {
                let _ = sender.send(BackendEvent::Terminated(TerminatedPayload {
                    code: status.code(),
                }));
                return;
            }
            Ok(ChildPoll::AlreadyReaped) => return,
            Err(_) => {
                if !reported_error {
                    let _ = sender.send(BackendEvent::Error);
                    reported_error = true;
                }
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
        }
    }
}

fn start_backend_events(
    state: Arc<BackendState>,
    stdout: ChildStdout,
    stderr: ChildStderr,
) -> Receiver<BackendEvent> {
    let (sender, receiver) = mpsc::channel();
    let stdout_sender = sender.clone();
    thread::spawn(move || pump_output(stdout, stdout_sender, BackendEvent::Stdout));
    let stderr_sender = sender.clone();
    thread::spawn(move || pump_output(stderr, stderr_sender, BackendEvent::Stderr));
    thread::spawn(move || monitor_backend(state, sender));
    receiver
}

fn write_smoke_ready_file(path: &Path) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(b"ready\n")?;
    file.sync_all()
}

fn signal_smoke_ready_from_env() -> io::Result<()> {
    match std::env::var_os(SMOKE_READY_FILE_ENV) {
        Some(path) => write_smoke_ready_file(Path::new(&path)),
        None => Ok(()),
    }
}

fn trusted_runtime_port(url: &Url) -> Option<u16> {
    if url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.username().is_empty()
        && url.password().is_none()
    {
        url.port()
    } else {
        None
    }
}

fn is_exact_startup_page(url: &Url) -> bool {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/" | "/index.html")
    {
        return false;
    }
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

fn navigation_allowed(url: &Url, runtime_port: Option<u16>) -> bool {
    match runtime_port {
        Some(port) => trusted_runtime_port(url) == Some(port),
        None => is_exact_startup_page(url),
    }
}

fn parse_ready_line(line: &str) -> Result<Option<Url>, String> {
    let Some(raw_url) = line.strip_prefix(READY_PREFIX) else {
        return Ok(None);
    };
    let url = Url::parse(raw_url).map_err(|error| format!("invalid readiness URL: {error}"))?;
    let port = url.port().filter(|port| *port != 0);
    let is_exact_origin = port.is_some_and(|port| {
        raw_url == format!("http://127.0.0.1:{port}")
            || raw_url == format!("http://127.0.0.1:{port}/")
    });
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !is_exact_origin
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "backend readiness URL must be an uncredentialed http://127.0.0.1:<port>/ origin"
                .into(),
        );
    }
    Ok(Some(url))
}

fn show_startup_error(window: &WebviewWindow, failure: StartupFailure) {
    let payload = serde_json::to_string(&failure.message())
        .unwrap_or_else(|_| "\"Desktop startup failed.\"".into());
    let script = format!(
        r#"(() => {{
          const message = {payload};
          const show = () => {{
            if (typeof window.desktopStartupError === 'function') {{
              window.desktopStartupError(message);
              return;
            }}
            const status = document.getElementById('status');
            const detail = document.getElementById('error-detail');
            if (status) status.textContent = 'Unofficial DeepSeek Harness Desktop could not start.';
            if (detail) {{ detail.textContent = message; detail.hidden = false; }}
          }};
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, {{ once: true }});
          else show();
        }})();"#
    );
    let _ = window.eval(script);
}

fn transition_starting_to_failed(phase: &AtomicU8) -> bool {
    let mut observed = phase.load(Ordering::SeqCst);
    loop {
        if observed != PENDING && observed != NAVIGATING {
            return false;
        }
        match phase.compare_exchange(observed, FAILED, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(actual) => observed = actual,
        }
    }
}

enum StartupReadySignal<'a> {
    AuthenticatedDocumentTitle {
        title: &'a str,
        url: &'a Url,
        runtime_port: Option<u16>,
    },
    #[cfg(test)]
    PageLoad(PageLoadEvent),
}

fn is_authenticated_ready_signal(signal: StartupReadySignal<'_>, ready_title: &str) -> bool {
    match signal {
        StartupReadySignal::AuthenticatedDocumentTitle {
            title,
            url,
            runtime_port,
        } => {
            !ready_title.is_empty()
                && title == ready_title
                && runtime_port.is_some()
                && trusted_runtime_port(url) == runtime_port
        }
        #[cfg(test)]
        StartupReadySignal::PageLoad(_event) => false,
    }
}

fn transition_authenticated_startup(
    phase: &AtomicU8,
    signal: StartupReadySignal<'_>,
    ready_title: &str,
) -> bool {
    is_authenticated_ready_signal(signal, ready_title)
        && phase
            .compare_exchange(NAVIGATING, READY, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

fn finish_authenticated_startup(window: &WebviewWindow, state: &Arc<BackendState>) {
    if signal_smoke_ready_from_env().is_err()
        && state
            .phase
            .compare_exchange(READY, FAILED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        state.stop_in_background();
        show_startup_error(window, StartupFailure::at(StartupStage::SmokeReadySignal));
    }
}

fn observe_document_title(
    window: &WebviewWindow,
    title: &str,
    navigation_policy: &NavigationPolicy,
    ready_title: &str,
) {
    let _ = window.set_title(APP_TITLE);
    let Ok(url) = window.url() else {
        return;
    };
    let app_handle = window.app_handle();
    let Some(state) = app_handle.try_state::<Arc<BackendState>>() else {
        return;
    };
    if transition_authenticated_startup(
        &state.phase,
        StartupReadySignal::AuthenticatedDocumentTitle {
            title,
            url: &url,
            runtime_port: navigation_policy.runtime_port(),
        },
        ready_title,
    ) {
        finish_authenticated_startup(window, &state);
    }
}

fn fail_starting(state: &Arc<BackendState>, window: &WebviewWindow, failure: StartupFailure) {
    if transition_starting_to_failed(&state.phase) {
        state.stop_in_background();
        show_startup_error(window, failure);
    }
}

fn termination_failure(
    payload: &TerminatedPayload,
    diagnostics: DiagnosticSummary,
) -> StartupFailure {
    StartupFailure::at(StartupStage::RuntimeExit)
        .with_exit_code(payload.code)
        .with_diagnostics(diagnostics)
}

#[cfg(target_os = "macos")]
fn is_session_export_download(url: &Url, runtime_port: Option<u16>) -> bool {
    runtime_port.is_some()
        && trusted_runtime_port(url) == runtime_port
        && url.path() == "/api/session.export"
        && url.fragment().is_none()
}

#[cfg(target_os = "macos")]
fn desktop_download_event_script(detail: serde_json::Value) -> String {
    format!(
        "window.dispatchEvent(new CustomEvent({event}, {{ detail: {detail} }}));",
        event = serde_json::to_string(DESKTOP_DOWNLOAD_EVENT)
            .expect("desktop download event name is serializable"),
    )
}

#[cfg(target_os = "macos")]
fn create_main_window(
    app: &tauri::App,
    navigation_policy: Arc<NavigationPolicy>,
    api_token: &str,
    ready_title: &str,
) -> Result<WebviewWindow, Box<dyn Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == MAIN_WINDOW)
        .ok_or("the configured main window is missing")?;
    let download_policy = navigation_policy.clone();
    let title_policy = navigation_policy.clone();
    let desktop_downloads = DesktopDownloads::default();
    let ready_title = ready_title.to_owned();
    let initialization_script = format!(
        "{}\n{}",
        desktop_auth_initialization_script(api_token, &ready_title),
        MACOS_PLATFORM_INITIALIZATION_SCRIPT,
    );
    let window = WebviewWindowBuilder::from_config(app.handle(), config)?
        .title(APP_TITLE)
        .initialization_script(initialization_script)
        .on_navigation(move |url| navigation_policy.allows(url))
        .on_document_title_changed(move |window, title| {
            observe_document_title(&window, &title, &title_policy, &ready_title);
        })
        .on_download(move |webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                if is_session_export_download(&url, download_policy.runtime_port()) {
                    desktop_downloads.record(&url, destination)
                } else {
                    false
                }
            }
            DownloadEvent::Finished { url, success, .. } => {
                if is_session_export_download(&url, download_policy.runtime_port()) {
                    let filename = desktop_downloads.finish(&url);
                    let completed = success && filename.is_some();
                    let mut detail = serde_json::json!({
                        "url": url.as_str(),
                        "phase": "finished",
                        "success": completed,
                    });
                    if let Some(filename) = filename {
                        detail["filename"] = serde_json::Value::String(filename);
                    }
                    let _ = webview.eval(desktop_download_event_script(detail));
                }
                true
            }
            _ => true,
        })
        .build()?;
    Ok(window)
}

#[cfg(not(target_os = "macos"))]
fn create_main_window(
    app: &tauri::App,
    navigation_policy: Arc<NavigationPolicy>,
    api_token: &str,
    ready_title: &str,
) -> Result<WebviewWindow, Box<dyn Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == MAIN_WINDOW)
        .ok_or("the configured main window is missing")?;
    let title_policy = navigation_policy.clone();
    let ready_title = ready_title.to_owned();
    Ok(WebviewWindowBuilder::from_config(app.handle(), config)?
        .title(APP_TITLE)
        .initialization_script(desktop_auth_initialization_script(api_token, &ready_title))
        .on_navigation(move |url| navigation_policy.allows(url))
        .on_document_title_changed(move |window, title| {
            observe_document_title(&window, &title, &title_policy, &ready_title);
        })
        .build()?)
}

fn setup(
    app: &mut tauri::App,
    navigation_policy: Arc<NavigationPolicy>,
) -> Result<(), Box<dyn Error>> {
    let api_token = generate_desktop_api_token()?;
    let ready_title = generate_desktop_ready_title()?;
    let window = create_main_window(app, navigation_policy.clone(), &api_token, &ready_title)?;
    let data_dir = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => {
            show_startup_error(&window, StartupFailure::at(StartupStage::AppDataResolution));
            return Ok(());
        }
    };
    if fs::create_dir_all(&data_dir).is_err() {
        show_startup_error(
            &window,
            StartupFailure::at(StartupStage::AppDataPreparation),
        );
        return Ok(());
    }

    let executable = match sidecar_path() {
        Ok(path) if path.is_file() => path,
        _ => {
            show_startup_error(&window, StartupFailure::at(StartupStage::RuntimeLocation));
            return Ok(());
        }
    };
    let (child, stdout, stderr, tree) = match spawn_backend(&executable, &data_dir, &api_token) {
        Ok(process) => process,
        Err(_) => {
            show_startup_error(&window, StartupFailure::at(StartupStage::RuntimeLaunch));
            return Ok(());
        }
    };

    let state = Arc::new(BackendState::new(child, tree));
    if !app.manage(state.clone()) {
        state.stop();
        show_startup_error(&window, StartupFailure::at(StartupStage::RuntimeLaunch));
        return Ok(());
    }
    let receiver = start_backend_events(state.clone(), stdout, stderr);
    let close_state = state.clone();
    let app_handle = app.handle().clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            let exit_code = if close_state.stop() { 0 } else { 1 };
            app_handle.exit(exit_code);
        }
    });

    let timeout_state = state.clone();
    let timeout_window = window.clone();
    thread::spawn(move || {
        thread::sleep(STARTUP_TIMEOUT);
        fail_starting(
            &timeout_state,
            &timeout_window,
            StartupFailure::at(StartupStage::ReadinessTimeout),
        );
    });

    let event_state = state.clone();
    let event_window = window.clone();
    let event_app = app.handle().clone();
    thread::spawn(move || {
        let mut diagnostics = DiagnosticSummary::default();
        while let Ok(event) = receiver.recv() {
            match event {
                BackendEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    match parse_ready_line(line.trim_end_matches(['\r', '\n'])) {
                        Ok(Some(url)) => {
                            if event_state
                                .phase
                                .compare_exchange(
                                    PENDING,
                                    NAVIGATING,
                                    Ordering::SeqCst,
                                    Ordering::SeqCst,
                                )
                                .is_err()
                            {
                                continue;
                            }
                            if navigation_policy.activate_runtime(&url).is_err() {
                                fail_starting(
                                    &event_state,
                                    &event_window,
                                    StartupFailure::at(StartupStage::ReadinessValidation),
                                );
                                continue;
                            }
                            match event_window.navigate(url) {
                                Ok(()) => {}
                                Err(_) => {
                                    fail_starting(
                                        &event_state,
                                        &event_window,
                                        StartupFailure::at(StartupStage::RuntimeNavigation),
                                    );
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(_) => fail_starting(
                            &event_state,
                            &event_window,
                            StartupFailure::at(StartupStage::ReadinessValidation),
                        ),
                    }
                }
                BackendEvent::Stderr(bytes) => diagnostics.observe(&bytes),
                BackendEvent::Error => fail_starting(
                    &event_state,
                    &event_window,
                    StartupFailure::at(StartupStage::RuntimeIo).with_diagnostics(diagnostics),
                ),
                BackendEvent::Terminated(payload) => {
                    let phase = event_state.phase.load(Ordering::SeqCst);
                    if phase == PENDING || phase == NAVIGATING {
                        fail_starting(
                            &event_state,
                            &event_window,
                            termination_failure(&payload, diagnostics),
                        );
                    } else if phase == READY {
                        event_state.stop();
                        event_app.exit(1);
                    }
                    return;
                }
            }
        }
        fail_starting(
            &event_state,
            &event_window,
            StartupFailure::at(StartupStage::OutputChannel).with_diagnostics(diagnostics),
        );
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let navigation_policy = Arc::new(NavigationPolicy::default());
    let navigation_guard = navigation_policy.clone();
    let setup_policy = navigation_policy.clone();
    let navigation_plugin =
        tauri::plugin::Builder::<tauri::Wry, ()>::new("desktop-navigation-guard")
            .on_navigation(move |webview, url| {
                webview.label() == MAIN_WINDOW && navigation_guard.allows(url)
            })
            .build();
    let app = tauri::Builder::default()
        .plugin(navigation_plugin)
        .on_page_load(move |webview, _payload| {
            if webview.label() == MAIN_WINDOW {
                let _ = webview.window().set_title(APP_TITLE);
            }
        })
        .setup(move |app| setup(app, setup_policy))
        .build(tauri::generate_context!())
        .expect("failed to build the unofficial DeepSeek Harness desktop application");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<Arc<BackendState>>() {
                state.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        configure_backend_environment, desktop_auth_initialization_script,
        generate_desktop_api_token, generate_desktop_ready_title, job_has_termination_target,
        navigation_allowed, parse_ready_line, termination_failure,
        transition_authenticated_startup, transition_starting_to_failed, write_smoke_ready_file,
        DiagnosticSummary, NavigationPolicy, StartupFailure, StartupReadySignal, StartupStage,
        TerminatedPayload, DESKTOP_API_TOKEN_ENV, DESKTOP_READY_TITLE_PREFIX, FAILED,
        MAX_DIAGNOSTIC_BYTES, MAX_DIAGNOSTIC_EVENTS, NAVIGATING, PENDING, READY,
        SMOKE_READY_FILE_ENV,
    };
    #[cfg(target_os = "macos")]
    use super::{
        desktop_download_event_script, is_session_export_download, DesktopDownloads, APP_TITLE,
        MACOS_PLATFORM_INITIALIZATION_SCRIPT,
    };
    use std::{
        ffi::OsStr,
        fs,
        process::Command,
        sync::atomic::{AtomicU8, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{webview::PageLoadEvent, Url};

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test URL")
    }

    #[test]
    fn accepts_only_the_loopback_runtime_origin() {
        let url = parse_ready_line("dsh web: http://127.0.0.1:43125")
            .expect("valid readiness line")
            .expect("readiness URL");
        assert_eq!(url.as_str(), "http://127.0.0.1:43125/");
        assert!(parse_ready_line("unrelated output")
            .expect("ordinary output")
            .is_none());
    }

    #[test]
    fn startup_failures_cover_pending_and_navigation_without_overwriting_ready() {
        for starting_phase in [PENDING, NAVIGATING] {
            let phase = AtomicU8::new(starting_phase);
            assert!(transition_starting_to_failed(&phase));
            assert_eq!(phase.load(Ordering::SeqCst), FAILED);
            assert!(!transition_starting_to_failed(&phase));
        }

        let ready = AtomicU8::new(READY);
        assert!(!transition_starting_to_failed(&ready));
        assert_eq!(ready.load(Ordering::SeqCst), READY);
    }

    #[test]
    fn rejects_untrusted_or_ambiguous_readiness_urls() {
        for line in [
            "dsh web: https://127.0.0.1:43125",
            "dsh web: http://localhost:43125",
            "dsh web: http://127.0.0.1",
            "dsh web: http://127.0.0.1:43125/path",
            "dsh web: http://user@127.0.0.1:43125",
            "dsh web: http://127.1:43125",
            "dsh web: http://0x7f000001:43125",
        ] {
            assert!(parse_ready_line(line).is_err(), "accepted {line}");
        }
    }

    #[test]
    fn navigation_starts_on_only_the_embedded_loading_page() {
        for allowed in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
        ] {
            assert!(
                navigation_allowed(&url(allowed), None),
                "rejected {allowed}"
            );
        }
        for rejected in [
            "https://tauri.localhost/",
            "http://tauri.localhost/path",
            "http://tauri.localhost/?next=http://127.0.0.1:43125",
            "http://user@tauri.localhost/",
            "http://localhost/",
            "file:///index.html",
            "about:blank",
        ] {
            assert!(
                !navigation_allowed(&url(rejected), None),
                "accepted {rejected}"
            );
        }
    }

    #[test]
    fn navigation_locks_to_the_validated_runtime_origin() {
        let policy = NavigationPolicy::default();
        assert!(policy.allows(&url("tauri://localhost")));
        policy
            .activate_runtime(&url("http://127.0.0.1:43125/"))
            .expect("trusted runtime origin");

        for allowed in [
            "http://127.0.0.1:43125/",
            "http://127.0.0.1:43125/session/one",
            "http://127.0.0.1:43125/?view=activity#latest",
        ] {
            assert!(policy.allows(&url(allowed)), "rejected {allowed}");
        }
        for rejected in [
            "tauri://localhost",
            "https://127.0.0.1:43125/",
            "http://localhost:43125/",
            "http://127.0.0.1:43126/",
            "http://user@127.0.0.1:43125/",
            "http://127.0.0.1/",
        ] {
            assert!(!policy.allows(&url(rejected)), "accepted {rejected}");
        }
    }

    #[test]
    fn page_load_events_never_complete_authenticated_startup() {
        for event in [PageLoadEvent::Started, PageLoadEvent::Finished] {
            let phase = AtomicU8::new(NAVIGATING);
            assert!(!transition_authenticated_startup(
                &phase,
                StartupReadySignal::PageLoad(event),
                "dsh-desktop-auth-ready-test",
            ));
            assert_eq!(phase.load(Ordering::SeqCst), NAVIGATING);
        }
    }

    #[test]
    fn only_the_exact_authenticated_title_at_the_runtime_origin_marks_ready() {
        let ready_title = "dsh-desktop-auth-ready-test";
        let phase = AtomicU8::new(NAVIGATING);
        assert!(transition_authenticated_startup(
            &phase,
            StartupReadySignal::AuthenticatedDocumentTitle {
                title: ready_title,
                url: &url("http://127.0.0.1:43125/session/one"),
                runtime_port: Some(43125),
            },
            ready_title,
        ));
        assert_eq!(phase.load(Ordering::SeqCst), READY);

        for (title, raw, port) in [
            ("wrong", "http://127.0.0.1:43125/", Some(43125)),
            (ready_title, "http://127.0.0.1:43126/", Some(43125)),
            (ready_title, "http://localhost:43125/", Some(43125)),
            (ready_title, "http://127.0.0.1:43125/", None),
        ] {
            let phase = AtomicU8::new(NAVIGATING);
            assert!(!transition_authenticated_startup(
                &phase,
                StartupReadySignal::AuthenticatedDocumentTitle {
                    title,
                    url: &url(raw),
                    runtime_port: port,
                },
                ready_title,
            ));
            assert_eq!(phase.load(Ordering::SeqCst), NAVIGATING);
        }
    }

    #[test]
    fn desktop_auth_script_uses_headers_and_websocket_protocols_only() {
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let ready_title =
            "dsh-desktop-auth-ready-fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        let script = desktop_auth_initialization_script(token, ready_title);

        assert!(script.contains("window.top !== window"));
        assert!(script.contains("location.origin !== 'http://127.0.0.1:' + location.port"));
        assert!(script.contains("Object.defineProperty(globalThis, '__DSH_DESKTOP_API_AUTH__'"));
        assert!(script.contains("value: true"));
        assert!(script.contains("writable: false"));
        assert!(script.contains("configurable: false"));
        assert!(script.contains("path === '/api' || path.startsWith('/api/')"));
        assert!(script.contains("const headers = new NativeHeaders(request.headers)"));
        assert!(script.contains("headers.set('Authorization', 'Bearer ' + desktopToken)"));
        assert!(script.contains("nativeFetch(new NativeRequest(request, { headers }))"));
        assert!(script.contains("!desktopReadySignalled && response.ok"));
        assert!(script.contains("socketUrl.pathname === '/api/events.mux'"));
        assert!(script.contains("socketUrl.pathname === '/api/events.host'"));
        assert!(script.contains("socketUrl.search === ''"));
        assert!(script.contains("socketUrl.hash === ''"));
        assert!(script.contains("['dsh-v1', 'dsh-auth-' + desktopToken]"));
        assert_eq!(script.matches(token).count(), 1);
        assert_eq!(script.matches(ready_title).count(), 1);
        assert!(!script.to_ascii_lowercase().contains("cookie"));
        for forbidden in [
            "document.cookie",
            "localStorage",
            "sessionStorage",
            "searchParams",
            "?token=",
            "&token=",
        ] {
            assert!(!script.contains(forbidden), "script contains {forbidden}");
        }
    }

    #[test]
    fn desktop_secrets_are_independent_lowercase_256_bit_values() {
        let token = generate_desktop_api_token().expect("generate API token");
        let ready_title = generate_desktop_ready_title().expect("generate ready title");
        assert_eq!(token.len(), 64);
        assert!(token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert!(ready_title.starts_with(DESKTOP_READY_TITLE_PREFIX));
        let nonce = &ready_title[DESKTOP_READY_TITLE_PREFIX.len()..];
        assert_eq!(nonce.len(), 64);
        assert!(nonce
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn backend_receives_the_api_token_but_not_the_smoke_marker_path() {
        let data_dir = std::path::Path::new("/tmp/dsh-desktop-command-test");
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let mut command = Command::new("dsh-backend");
        command.env(SMOKE_READY_FILE_ENV, "/tmp/forged-ready");
        configure_backend_environment(&mut command, data_dir, token);

        let smoke_ready = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new(SMOKE_READY_FILE_ENV))
            .expect("explicit smoke-marker removal");
        assert!(smoke_ready.1.is_none());
        let api_token = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new(DESKTOP_API_TOKEN_ENV))
            .expect("desktop API token environment");
        assert_eq!(api_token.1, Some(OsStr::new(token)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bridge_accepts_only_session_exports_from_the_validated_runtime_port() {
        assert!(is_session_export_download(
            &url("http://127.0.0.1:43125/api/session.export?sessionId=test"),
            Some(43125),
        ));
        for (raw, port) in [
            (
                "https://127.0.0.1:43125/api/session.export?sessionId=test",
                Some(43125),
            ),
            (
                "http://localhost:43125/api/session.export?sessionId=test",
                Some(43125),
            ),
            (
                "http://127.0.0.1:43126/api/session.export?sessionId=test",
                Some(43125),
            ),
            ("http://127.0.0.1:43125/api/other", Some(43125)),
            (
                "http://127.0.0.1:43125/api/session.export#fragment",
                Some(43125),
            ),
            (
                "http://127.0.0.1:43125/api/session.export?sessionId=test",
                None,
            ),
        ] {
            assert!(
                !is_session_export_download(&url(raw), port),
                "accepted {raw} with {port:?}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_download_events_json_escape_untrusted_filenames() {
        let script = desktop_download_event_script(serde_json::json!({
            "filename": "archive\";window.injected=true;//.zip"
        }));
        assert!(script.contains("archive\\\";window.injected=true;//.zip"));
        assert!(!script.contains("detail: {\"filename\":\"archive\";"));
        assert_eq!(
            MACOS_PLATFORM_INITIALIZATION_SCRIPT,
            "Object.defineProperty(globalThis,'__DSH_DESKTOP_PLATFORM__',{value:'macos',writable:false,configurable:false});"
        );
        assert_eq!(APP_TITLE, "Unofficial DeepSeek Harness Desktop");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_download_completion_owns_the_requested_filename_fifo() {
        let downloads = DesktopDownloads::default();
        let export = url("http://127.0.0.1:43125/api/session.export?sessionId=test");
        assert!(downloads.record(&export, std::path::Path::new("/Downloads/session.zip")));
        assert!(downloads.record(&export, std::path::Path::new("/Downloads/session (1).zip"),));
        assert_eq!(downloads.finish(&export).as_deref(), Some("session.zip"));
        assert_eq!(
            downloads.finish(&export).as_deref(),
            Some("session (1).zip")
        );
        assert_eq!(downloads.finish(&export), None);
    }

    #[test]
    fn startup_failure_messages_never_include_stderr_content() {
        let secret = b"ANTHROPIC_API_KEY=not-for-the-ui";
        let mut diagnostics = DiagnosticSummary::default();
        for _ in 0..=MAX_DIAGNOSTIC_EVENTS {
            diagnostics.observe(&[secret.as_slice(), &[b'X'; 128]].concat());
        }
        assert_eq!(diagnostics.events, MAX_DIAGNOSTIC_EVENTS);
        assert_eq!(diagnostics.bytes, MAX_DIAGNOSTIC_BYTES);
        assert!(diagnostics.truncated);

        let message = StartupFailure::at(StartupStage::RuntimeExit)
            .with_exit_code(Some(17))
            .with_diagnostics(diagnostics)
            .message();
        assert_eq!(
            message,
            "Desktop startup failed (stage: runtime-exit). Exit code: 17. Diagnostics: 8 event(s), 500 byte(s), truncated."
        );
        assert!(!message.contains("ANTHROPIC_API_KEY"));
        assert!(!message.contains("not-for-the-ui"));
    }

    #[test]
    fn termination_failure_reports_exit_code_but_not_signal_or_output() {
        let failure = termination_failure(
            &TerminatedPayload { code: None },
            DiagnosticSummary {
                events: 1,
                bytes: 27,
                truncated: false,
            },
        );
        assert_eq!(
            failure.message(),
            "Desktop startup failed (stage: runtime-exit). Diagnostics: 1 event(s), 27 byte(s)."
        );
    }

    #[test]
    fn job_target_probe_keeps_descendants_owned_after_the_root_is_reaped() {
        assert!(!job_has_termination_target(Ok(0)));
        assert!(job_has_termination_target(Ok(1)));
        assert!(job_has_termination_target(Ok(7)));
        assert!(job_has_termination_target(Err(())));
    }

    #[test]
    fn smoke_ready_file_is_new_fixed_content_and_never_overwritten() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after Unix epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("dsh-desktop-smoke-{}-{nonce}", std::process::id()));

        write_smoke_ready_file(&path).expect("create smoke marker");
        assert_eq!(fs::read(&path).expect("read smoke marker"), b"ready\n");
        let error = write_smoke_ready_file(&path).expect_err("must not overwrite marker");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        fs::remove_file(path).expect("remove smoke marker");
    }

    #[cfg(unix)]
    #[test]
    fn unix_shutdown_kills_the_entire_dedicated_process_group() {
        use super::{
            configure_backend_command, process_group_target, signal_process_group, BackendState,
            ProcessTree,
        };
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
            time::{Duration, Instant},
        };

        assert_eq!(process_group_target(43125), Some(-43125));
        assert_eq!(process_group_target(0), None);
        assert_eq!(process_group_target(u32::MAX), None);

        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "trap '' TERM; sh -c 'trap \"\" TERM; while :; do sleep 1; done' & echo $!; wait",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_backend_command(&mut command);
        let mut child = command.spawn().expect("spawn isolated process tree");
        let pid = child.id();
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut descendant = String::new();
        stdout
            .read_line(&mut descendant)
            .expect("read descendant pid");
        assert!(
            descendant.trim().parse::<u32>().is_ok(),
            "invalid descendant pid"
        );

        let state = BackendState::new(
            child,
            ProcessTree::new().expect("create Unix process-tree guard"),
        );
        let started = Instant::now();
        assert!(state.stop(), "shutdown did not reach quiescence");
        assert!(
            started.elapsed() >= Duration::from_millis(1_300),
            "SIGTERM-ignoring group was not given the graceful wait"
        );
        assert!(
            state
                .process
                .lock()
                .expect("backend process state")
                .child
                .is_none(),
            "root child was not reaped"
        );
        assert!(state.stop(), "idempotent stop lost quiescence state");

        let deadline = Instant::now() + Duration::from_secs(1);
        while signal_process_group(pid, 0) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !signal_process_group(pid, 0),
            "process group survived shutdown"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_kills_a_descendant_after_its_root_exits() {
        use super::{configure_backend_command, spawn_managed_process};
        use std::{
            io::{BufRead, BufReader},
            os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        use windows_sys::Win32::{
            Foundation::STILL_ACTIVE,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };

        fn process_is_running(pid: u32) -> bool {
            // SAFETY: OpenProcess receives a concrete PID and requests query-only
            // access. A successful handle is immediately placed under RAII.
            let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if raw.is_null() {
                return false;
            }
            // SAFETY: OpenProcess returned a new owned HANDLE on success.
            let process = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut exit_code = 0;
            // SAFETY: process is live and exit_code points to writable u32 storage.
            let queried =
                unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit_code) != 0 };
            queried && exit_code == STILL_ACTIVE as u32
        }

        let script = concat!(
            "Start-Sleep -Milliseconds 500; ",
            "$child = Start-Process -FilePath powershell.exe -WindowStyle Hidden -PassThru ",
            "-ArgumentList '-NoLogo -NoProfile -NonInteractive -Command Start-Sleep -Seconds 120'; ",
            "[Console]::Out.WriteLine($child.Id)"
        );
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_backend_command(&mut command);
        let (mut root, tree) = spawn_managed_process(&mut command).expect("spawn job root");
        let mut output = BufReader::new(root.stdout.take().expect("job root stdout"));
        let mut descendant = String::new();
        output
            .read_line(&mut descendant)
            .expect("read descendant pid");
        let descendant = descendant
            .trim()
            .parse::<u32>()
            .expect("valid descendant pid");
        assert!(root.wait().expect("wait for job root").success());
        assert!(
            process_is_running(descendant),
            "descendant exited before job close"
        );
        assert!(
            tree.active_process_count().expect("query job membership") >= 1,
            "job lost the descendant when its root exited"
        );

        drop(tree);
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_running(descendant) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        if process_is_running(descendant) {
            let descendant_arg = descendant.to_string();
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &descendant_arg, "/T", "/F"])
                .status();
            panic!("Windows Job Object close left descendant {descendant} running");
        }
    }
}
