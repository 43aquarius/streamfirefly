#[cfg(not(windows))]
use std::fs;
use std::io;
use std::path::Path;

#[cfg(windows)]
const MOVEFILE_REPLACE_EXISTING: u32 = 1;
#[cfg(windows)]
const MOVEFILE_WRITE_THROUGH: u32 = 8;

#[cfg(not(windows))]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    move_file(source, destination, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
}

/// Moves a finished file into place on the same volume. Fails with `AlreadyExists`
/// instead of replacing whatever is already at the destination.
#[cfg(not(windows))]
pub(crate) fn move_new_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

#[cfg(windows)]
pub(crate) fn move_new_file(source: &Path, destination: &Path) -> io::Result<()> {
    move_file(source, destination, MOVEFILE_WRITE_THROUGH)
}

#[cfg(windows)]
fn move_file(source: &Path, destination: &Path, flags: u32) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
