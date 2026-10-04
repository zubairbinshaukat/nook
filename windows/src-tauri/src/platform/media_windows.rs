// The Windows half of the Media widget (media.rs): the system media transport
// controls — what any player tells Windows it is playing — and Core Audio for
// the master volume. Local calls only. Each function is called from a worker
// thread of Tauri's (the page's commands are async) and waits for the system's
// answer there; none of it touches the page's thread.

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK,
};

use super::{app_name, data_url, position_ms, Action, MediaState};

/// Album art bigger than this is not read: a thumbnail is a few hundred kilobytes at most.
const MAX_COVER_BYTES: u64 = 2_000_000;

/// The seconds between the system's epoch (1601) and Unix's (1970).
const EPOCH_GAP_SECS: i64 = 11_644_473_600;

/// A thread is made ready for the system's calls for as long as this is held.
struct Com(bool);

impl Com {
    fn ready() -> Com {
        // S_OK and S_FALSE both count and must be balanced; a thread that is already set up another way is left as it is.
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// The player Windows would send the media keys to: none when nothing has told it it is playing.
///
/// One that is playing comes first: Windows' own "current" session can be a
/// player that stopped a while ago (or a tab that only made a sound) while a
/// browser plays, and the buttons would then press nothing.
fn session() -> windows::core::Result<Option<Session>> {
    let manager = Manager::RequestAsync()?.get()?;
    if let Ok(all) = manager.GetSessions() {
        for one in all {
            let playing = one.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).map(|s| s == Status::Playing).unwrap_or(false);
            if playing {
                return Ok(Some(one));
            }
        }
    }
    Ok(manager.GetCurrentSession().ok())
}

/// The keyboard's own media key, pressed and let go: what a player that would
/// not take the session's call (a browser tab, often) still listens to.
fn media_key(action: Action) {
    let key = match action {
        Action::Previous => VK_MEDIA_PREV_TRACK,
        Action::Toggle => VK_MEDIA_PLAY_PAUSE,
        Action::Next => VK_MEDIA_NEXT_TRACK,
    };
    let stroke = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: key, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let strokes = [stroke(KEYEVENTF_EXTENDEDKEY), stroke(KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP)];
    unsafe { SendInput(&strokes, std::mem::size_of::<INPUT>() as i32) };
}

/// Now, as the system counts it: 100 ns steps since 1601.
fn system_now() -> i64 {
    let since_unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() / 100).unwrap_or(0) as i64;
    since_unix + EPOCH_GAP_SECS * 10_000_000
}

fn read_state() -> windows::core::Result<Option<MediaState>> {
    let Some(session) = session()? else { return Ok(None) };
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let info = session.GetPlaybackInfo()?;
    let playing = info.PlaybackStatus()? == Status::Playing;
    let controls = info.Controls()?;
    let timeline = session.GetTimelineProperties()?;
    let (position, duration) = position_ms(
        timeline.Position()?.Duration,
        timeline.StartTime()?.Duration,
        timeline.EndTime()?.Duration,
        timeline.LastUpdatedTime()?.UniversalTime,
        system_now(),
        playing,
    );
    let app = app_name(&session.SourceAppUserModelId()?.to_string());
    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    let album = props.AlbumTitle()?.to_string();
    Ok(Some(MediaState {
        kind: "session",
        reason: None,
        track_key: format!("{app}|{title}|{artist}|{album}"),
        title,
        artist,
        album,
        app,
        playing,
        position_ms: position,
        duration_ms: duration,
        can_previous: controls.IsPreviousEnabled().unwrap_or(false),
        can_next: controls.IsNextEnabled().unwrap_or(false),
        can_toggle: controls.IsPlayEnabled().unwrap_or(false) || controls.IsPauseEnabled().unwrap_or(false),
    }))
}

pub fn state() -> MediaState {
    let _com = Com::ready();
    match read_state() {
        Ok(Some(state)) => state,
        Ok(None) => MediaState::none(),
        Err(err) => MediaState::unavailable(format!("Windows would not say what is playing ({err}).")),
    }
}

fn read_cover() -> windows::core::Result<Option<String>> {
    let Some(session) = session()? else { return Ok(None) };
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let Ok(thumbnail) = props.Thumbnail() else { return Ok(None) };
    let stream = thumbnail.OpenReadAsync()?.get()?;
    let size = stream.Size()?;
    if size == 0 || size > MAX_COVER_BYTES {
        return Ok(None);
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    reader.LoadAsync(size as u32)?.get()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(data_url(&bytes))
}

pub fn cover() -> Option<String> {
    let _com = Com::ready();
    read_cover().ok().flatten()
}

fn press(action: Action) -> windows::core::Result<bool> {
    let Some(session) = session()? else { return Ok(false) };
    match action {
        Action::Previous => session.TrySkipPreviousAsync()?.get(),
        Action::Toggle => session.TryTogglePlayPauseAsync()?.get(),
        Action::Next => session.TrySkipNextAsync()?.get(),
    }
}

pub fn control(action: Action) -> bool {
    let _com = Com::ready();
    let pressed = press(action);
    crate::log::line(format!("media: {action:?} -> {pressed:?}"));
    if matches!(pressed, Ok(true)) {
        return true;
    }
    // The player did not take it: the media key says the same thing to whoever listens for it.
    media_key(action);
    true
}

// ── Volume: the system's master volume of the default speakers ────────────────

fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
    }
}

pub fn volume() -> Option<u8> {
    let _com = Com::ready();
    let level = unsafe { endpoint().ok()?.GetMasterVolumeLevelScalar().ok()? };
    Some((level * 100.0).round().clamp(0.0, 100.0) as u8)
}

pub fn set_volume(percent: u8) -> bool {
    let _com = Com::ready();
    let Ok(endpoint) = endpoint() else { return false };
    unsafe { endpoint.SetMasterVolumeLevelScalar(f32::from(percent) / 100.0, std::ptr::null()) }.is_ok()
}
