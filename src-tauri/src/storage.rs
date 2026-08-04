use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Stable content fingerprint used to reconnect metadata after a PDF is
/// renamed or moved. SHA-256 also makes accidental attachment to a different
/// document vanishingly unlikely.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn temporary_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("rustypdf-data");
    parent_directory(target).join(format!(".{name}.{}.tmp", Uuid::new_v4()))
}

#[cfg(not(target_os = "windows"))]
fn replace_file(temp: &Path, target: &Path) -> io::Result<()> {
    // POSIX rename replaces an existing destination atomically when both
    // paths are on the same filesystem. The temporary file is deliberately
    // created next to the destination to guarantee that condition.
    std::fs::rename(temp, target)
}

#[cfg(target_os = "windows")]
fn replace_file(temp: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let from: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Write a complete replacement next to `target`, flush it, and atomically
/// swap it into place. A failed write never truncates the previous file.
pub fn atomic_write(target: impl AsRef<Path>, bytes: &[u8]) -> io::Result<()> {
    let target = target.as_ref();
    let parent = parent_directory(target);
    std::fs::create_dir_all(parent)?;
    let temp = temporary_path(target);

    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;

        if let Ok(metadata) = std::fs::metadata(target) {
            file.set_permissions(metadata.permissions())?;
        }

        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp, target)?;

        // Persist the directory entry itself where the platform supports
        // directory fsync. This closes the final power-loss window on POSIX.
        #[cfg(unix)]
        if let Ok(directory) = File::open(parent) {
            // The rename has already committed at this point. Some network
            // and virtual filesystems reject directory fsync; treating that
            // post-commit durability hint as a failed save would leave the
            // caller's in-memory revision behind bytes that are already on
            // disk. Keep it best-effort once replacement has succeeded.
            let _ = directory.sync_all();
        }

        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, sha256_hex};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn atomic_write_replaces_complete_file_without_temp_residue() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("rustpdf-atomic-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("document.pdf");
        std::fs::write(&target, b"old").unwrap();

        atomic_write(&target, b"complete replacement").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"complete replacement");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("document.pdf")]);

        let _ = std::fs::remove_file(target);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn sha256_fingerprint_is_stable() {
        assert_eq!(
            sha256_hex(b"rustypdf"),
            "19b4a7251d4a60be033ab66b0e6d23c1234111466624b0cbff2c3c3ea7b7918f"
        );
    }
}
