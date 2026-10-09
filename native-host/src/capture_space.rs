use std::path::Path;

/// Bytes the current user may still write on the volume holding `path`; `None` when unknown.
#[cfg(windows)]
pub(crate) fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let directory: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    let succeeded = unsafe {
        GetDiskFreeSpaceExW(
            directory.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } != 0;
    succeeded.then_some(available)
}

#[cfg(not(windows))]
pub(crate) fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// How many bytes are missing; an unknown amount of free space never blocks the caller.
pub(crate) fn shortfall(needed: u64, free: Option<u64>) -> Option<u64> {
    free.filter(|free| *free < needed).map(|free| needed - free)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_missing_bytes_only_when_free_space_is_known_and_short() {
        assert_eq!(shortfall(100, Some(40)), Some(60));
        assert_eq!(shortfall(100, Some(100)), None);
        assert_eq!(shortfall(100, None), None);
    }

    #[cfg(windows)]
    #[test]
    fn queries_the_volume_of_an_existing_directory() {
        assert!(free_bytes(&std::env::temp_dir()).is_some_and(|free| free > 0));
    }
}
