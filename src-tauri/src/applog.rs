//! Errors to the platform log: logcat on Android, stderr elsewhere.
//!
//! On Android, stderr is discarded, so `eprintln!` and the default panic
//! message never reach `adb logcat`. Read these with:
//! `adb logcat -s NaturalVoiceReader`

/// Log an error message.
pub fn error(message: &str) {
    #[cfg(target_os = "android")]
    android::write(message);
    #[cfg(not(target_os = "android"))]
    eprintln!("{message}");
}

/// Send panic messages to logcat as well as the default handler.
#[cfg(target_os = "android")]
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        error(&format!("panic: {info}"));
        previous(info);
    }));
}

/// An error and its causes, joined: "error sending request: … : invalid peer certificate: UnknownIssuer".
pub fn chain(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let next = cause.to_string();
        if !text.contains(&next) {
            text.push_str(": ");
            text.push_str(&next);
        }
        source = cause.source();
    }
    text
}

/// The innermost cause, which is usually the useful part to show a user.
pub fn root_cause(err: &dyn std::error::Error) -> String {
    let mut current = err;
    while let Some(next) = current.source() {
        current = next;
    }
    current.to_string()
}

#[cfg(target_os = "android")]
mod android {
    use std::ffi::{c_char, c_int, CString};

    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    const ANDROID_LOG_ERROR: c_int = 6;

    pub fn write(message: &str) {
        let text = CString::new(message.replace('\0', " ")).unwrap_or_default();
        // SAFETY: both pointers are valid NUL-terminated strings for the call.
        unsafe {
            __android_log_write(ANDROID_LOG_ERROR, c"NaturalVoiceReader".as_ptr(), text.as_ptr());
        }
    }
}
