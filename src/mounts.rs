use anyhow::{Result, ensure};
use std::path::{Path, PathBuf};

pub fn reject_under(root: &Path, mounts: &[PathBuf]) -> Result<()> {
    for mount in mounts {
        ensure!(
            !mount.starts_with(root),
            "Mounted tree is not removable: {}",
            mount.display()
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn check(root: &Path) -> Result<()> {
    use std::{ffi::CStr, os::unix::ffi::OsStrExt};
    let mut entries: *mut libc::statfs = std::ptr::null_mut();
    // getmntinfo owns this snapshot. Copy the paths before another call; this
    // helper does not call getmntinfo from its command-output reader threads.
    let count = unsafe { libc::getmntinfo(&mut entries, libc::MNT_NOWAIT) };
    ensure!(
        count > 0 && !entries.is_null(),
        "Cannot read mounted filesystems"
    );
    let mounts: Vec<_> = unsafe { std::slice::from_raw_parts(entries, count as usize) }
        .iter()
        .map(|entry| {
            let bytes = unsafe { CStr::from_ptr(entry.f_mntonname.as_ptr()) }.to_bytes();
            PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
        })
        .collect();
    reject_under(root, &mounts)
}

#[cfg(target_os = "linux")]
pub fn check(root: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStringExt;
    let data = std::fs::read("/proc/self/mountinfo")?;
    let mut mounts = Vec::new();
    for line in data.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let fields: Vec<_> = line.split(|b| *b == b' ').collect();
        ensure!(fields.len() > 6, "Invalid mountinfo record");
        let mut decoded = Vec::new();
        let mut at = 0;
        while at < fields[4].len() {
            let bytes = fields[4];
            if bytes[at] == b'\\' {
                ensure!(
                    at + 3 < bytes.len()
                        && bytes[at + 1..at + 4]
                            .iter()
                            .all(|b| (b'0'..=b'7').contains(b)),
                    "Invalid mount path escape"
                );
                decoded.push(
                    (bytes[at + 1] - b'0') * 64 + (bytes[at + 2] - b'0') * 8 + bytes[at + 3] - b'0',
                );
                at += 4;
            } else {
                decoded.push(bytes[at]);
                at += 1;
            }
        }
        mounts.push(PathBuf::from(std::ffi::OsString::from_vec(decoded)));
    }
    reject_under(root, &mounts)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn check(_root: &Path) -> Result<()> {
    anyhow::bail!("Removal is supported on macOS and Linux only")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_mounts_including_same_device_bind_locations_without_traversal() {
        let root = Path::new("/workspaces/topic");
        assert!(reject_under(root, &["/".into(), "/workspaces".into()]).is_ok());
        assert!(reject_under(root, &["/workspaces/topic/ignored/mount".into()]).is_err());
        assert!(reject_under(root, &[root.into()]).is_err());
        assert!(reject_under(root, &["/workspaces/topic-other".into()]).is_ok());
    }
}
