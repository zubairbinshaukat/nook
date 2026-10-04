//! The little bit of Win32 the relay needs: who we are, who is on the other
//! end of the pipe, and which processes we were started under.
//!
//! Named pipes live in a machine-wide namespace, so `\\.\pipe\nook-<name>` can
//! be created by *any* account that gets there first. Two defences, both cheap:
//! the pipe name carries our SID, and once connected we check the server process
//! really belongs to us before sending anything.

use std::time::{Duration, Instant};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, LocalFree, HLOCAL};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TokenUser,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::{Proc, CONNECT_TIMEOUT};

/// `ERROR_PIPE_BUSY` — every instance is serving someone else right now. This is
/// the one error worth retrying: the server exists and a slot will free up.
const ERROR_PIPE_BUSY: i32 = 231;

/// `\\.\pipe\nook-<sid>`. The SID keeps two accounts on the same machine from
/// ever meeting on the same pipe; the name falls back to the user name only if
/// the SID cannot be read at all, which should not happen.
fn pipe_path() -> String {
    let key = current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\nook-{key}")
}

/// Opens the pipe. Retries only while the server is busy: any other error means
/// there is nothing to talk to, and waiting would only delay Claude Code.
pub fn connect() -> Option<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let path = pipe_path();
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = HANDLE(file.as_raw_handle());
                // Somebody else's server on our pipe name gets nothing from us.
                return pipe_server_is_nook(handle).then_some(file);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe { token_sid(GetCurrentProcess()) }
}

/// True when the process serving `handle` looks like Nook: our own user, an
/// image called nook.exe, and an integrity level no lower than ours.
///
/// The same-user check stops another account. The other two narrow what a
/// process of our own account can pass for: the app's path is not known to the
/// relay (the installer may put it anywhere), so its file name stands in, and
/// a server below our integrity level can never be Nook run by us (it matters
/// when Claude Code runs elevated). This cannot stop code that runs as us at
/// our own level and is called nook.exe.
///
/// A failure to answer is treated as "not Nook": refusing costs one hook event
/// and Claude Code asks in the terminal, while trusting could hand the contents
/// of every tool call to a stranger.
pub fn pipe_server_is_nook(handle: HANDLE) -> bool {
    let Some(mine) = current_user_sid() else { return false };
    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeServerProcessId(handle, &mut pid).is_err() || pid == 0 {
            return false;
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let same_user = token_sid(process).as_deref() == Some(mine.as_str());
        let image = image_path(process);
        let theirs = integrity_level(process);
        let _ = CloseHandle(process);
        let ours = integrity_level(GetCurrentProcess());
        same_user && image.as_deref().is_some_and(is_nook_image) && integrity_not_lower(theirs, ours)
    }
}

/// `nook.exe`, whatever folder it sits in and however it is cased.
fn is_nook_image(path: &str) -> bool {
    path.rsplit(['\\', '/']).next().is_some_and(|name| name.eq_ignore_ascii_case("nook.exe"))
}

/// The server must be at our level or above; an unreadable level is a refusal.
fn integrity_not_lower(server: Option<u32>, relay: Option<u32>) -> bool {
    matches!((server, relay), (Some(s), Some(r)) if s >= r)
}

/// The full path of a process's image. `process` is borrowed, never closed.
unsafe fn image_path(process: HANDLE) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// The integrity level's RID of a process (0x2000 medium, 0x3000 high, …).
unsafe fn integrity_level(process: HANDLE) -> Option<u32> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
    let mut needed = 0u32;
    let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
    if needed == 0 {
        let _ = CloseHandle(token);
        return None;
    }
    // u64 elements keep the buffer aligned for the structure inside it.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let ok = GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr().cast()), needed, &mut needed).is_ok();
    let _ = CloseHandle(token);
    if !ok {
        return None;
    }
    let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
    let sid = label.Label.Sid;
    let count = *GetSidSubAuthorityCount(sid);
    if count == 0 {
        return None;
    }
    Some(*GetSidSubAuthority(sid, u32::from(count) - 1))
}

/// The processes above this one — our parent, its parent, and so on — nearest
/// first, `max` of them at most. Windows Terminal, VS Code and the shells sit
/// somewhere up this chain, and the island's ↗ goes to the window of one of them.
///
/// One snapshot of the process table, read once. A process only records the
/// *pid* of what started it, and a pid is given out again once its process is
/// gone: an ancestor that was created after its child is not its parent, and
/// the chain stops there rather than name a stranger. Whatever fails, the
/// chain is simply shorter.
pub fn ancestors(max: usize) -> Vec<Proc> {
    use std::collections::HashMap;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut table: HashMap<u32, (u32, String)> = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return Vec::new() };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            table.insert(entry.th32ProcessID, (entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }

    let mut chain: Vec<Proc> = Vec::new();
    let mut pid = std::process::id();
    let mut born = created_at(pid);
    while chain.len() < max {
        let Some((parent, _)) = table.get(&pid) else { break };
        let parent = *parent;
        let Some((_, name)) = table.get(&parent) else { break };
        if parent == 0 || parent == pid || chain.iter().any(|p| p.pid == parent) {
            break;
        }
        // Older than its child, or it is somebody else wearing the pid.
        let parent_born = created_at(parent);
        match (parent_born, born) {
            (Some(theirs), Some(ours)) if theirs <= ours => {}
            _ => break,
        }
        chain.push(Proc { pid: parent, name: name.clone() });
        pid = parent;
        born = parent_born;
    }
    chain
}

/// When a process was created, as the system counts it; None when it will not say.
fn created_at(pid: u32) -> Option<u64> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let (mut created, mut exited, mut kernel, mut user) = Default::default();
        let read = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(process);
        read.then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}

/// The user SID behind a process handle. `process` is borrowed, never closed.
unsafe fn token_sid(process: HANDLE) -> Option<String> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;

    // First call sizes the buffer, second fills it.
    let mut needed = 0u32;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
    if needed == 0 {
        let _ = CloseHandle(token);
        return None;
    }
    let mut buf = vec![0u8; needed as usize];
    let ok = GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr().cast()),
        needed,
        &mut needed,
    )
    .is_ok();
    let _ = CloseHandle(token);
    if !ok {
        return None;
    }

    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
    let sid = text.to_string().ok();
    let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
    sid
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_file_called_nook_exe_passes_for_nook() {
        assert!(is_nook_image(r"C:\Program Files\Nook\nook.exe"));
        assert!(is_nook_image(r"D:\work\nook\target\release\NOOK.EXE"));
        assert!(!is_nook_image(r"C:\Users\me\AppData\Local\Temp\evil.exe"));
        assert!(!is_nook_image(r"C:\x\not-nook.exe"));
        assert!(!is_nook_image(r"C:\nook.exe\payload.exe"));
    }

    #[test]
    fn a_server_below_the_relays_level_is_refused() {
        assert!(integrity_not_lower(Some(0x2000), Some(0x2000)));
        assert!(integrity_not_lower(Some(0x3000), Some(0x2000)));
        assert!(!integrity_not_lower(Some(0x2000), Some(0x3000)));
        assert!(!integrity_not_lower(None, Some(0x2000)));
        assert!(!integrity_not_lower(Some(0x2000), None));
    }
}