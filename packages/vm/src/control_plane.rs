use anyhow::{bail, Context, Result};
use ring::digest::{Context as DigestContext, SHA256};
use std::fmt::Write as _;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::io::Write;
use std::path::Path;

fn digest_open_file(file: &mut File) -> Result<String> {
    let mut context = DigestContext::new(&SHA256);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    let mut digest = String::with_capacity(64);
    for byte in context.finish().as_ref() {
        let _ = write!(digest, "{byte:02x}");
    }
    Ok(digest)
}

#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn open_verified_artifact(
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<File> {
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("invalid expected artifact sha256");
    }
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let size = file.metadata()?.len();
    if size != expected_size {
        bail!(
            "artifact size changed before transfer {}: expected {expected_size}, got {size}",
            path.display()
        );
    }
    let actual = digest_open_file(&mut file)?;
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        bail!(
            "artifact sha256 changed before transfer {}: expected {expected_sha256}, got {actual}",
            path.display()
        );
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

pub(crate) fn artifact_identity(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let size = file.metadata()?.len();
    let digest = digest_open_file(&mut file)?;
    Ok((digest, size))
}

#[cfg(unix)]
pub(crate) fn send_artifact(
    socket_path: &Path,
    slot: &str,
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<()> {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;

    if !matches!(
        slot,
        "binary" | "console" | "checksums" | "properties" | "payload" | "envelope"
    ) {
        bail!("invalid artifact slot '{slot}'");
    }
    let mut source = open_verified_artifact(path, expected_sha256, expected_size)?;
    let mut stream = UnixStream::connect(socket_path)
        .with_context(|| format!("connect raw artifact relay {}", socket_path.display()))?;
    let timeout = Some(std::time::Duration::from_secs(180));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;
    writeln!(
        stream,
        "{slot} {expected_size} {}",
        expected_sha256.to_ascii_lowercase()
    )?;
    std::io::copy(&mut source, &mut stream)?;
    stream.shutdown(Shutdown::Write)?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    if response.trim() != "ok" {
        bail!("guest rejected {slot} artifact: {}", response.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_root(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ap-cp-{label}-{}-{nonce}", std::process::id()))
    }

    #[cfg(unix)]
    #[test]
    fn raw_sender_preserves_header_and_bytes_with_a_fake_receiver() {
        use std::os::unix::net::UnixListener;
        use std::thread;

        let root = temp_test_root("send");
        std::fs::create_dir_all(&root).unwrap();
        let socket = root.join("receiver.sock");
        let source = root.join("artifact");
        std::fs::write(&source, b"signed bytes").unwrap();
        let (sha, size) = artifact_identity(&source).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let expected_sha = sha.clone();
        let receiver = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream);
            let mut header = String::new();
            std::io::BufRead::read_line(&mut reader, &mut header).unwrap();
            assert_eq!(header, format!("binary {size} {expected_sha}\n"));
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"signed bytes");
            reader.get_mut().write_all(b"ok\n").unwrap();
        });
        send_artifact(&socket, "binary", &source, &sha, size).unwrap();
        receiver.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sender_refuses_a_changed_open_handle_identity() {
        let root = temp_test_root("identity");
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("artifact");
        std::fs::write(&source, b"changed").unwrap();
        assert!(open_verified_artifact(&source, &"a".repeat(64), 7).is_err());
        assert!(
            open_verified_artifact(&source, &artifact_identity(&source).unwrap().0, 8).is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
