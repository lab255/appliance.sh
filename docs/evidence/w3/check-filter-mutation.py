from pathlib import Path
import subprocess,os
p=Path('packages/desktop/src-tauri/src/inspection.rs');original=p.read_text();start=original.index('fn initial_git_status(root:');end=original.index('fn load(path:',start)
unsafe='''fn initial_git_status(root: &Path) -> Result<String, git2::Error> {
    let output = std::process::Command::new("git")
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "status", "--porcelain=v1", "--ignore-submodules=all"])
        .current_dir(root).output().map_err(|e| git2::Error::from_str(&e.to_string()))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
'''
try:
 p.write_text(original[:start]+unsafe+original[end:])
 env=os.environ.copy();env['TAURI_CONFIG']='{"bundle":{"resources":[],"externalBin":[]}}'
 result=subprocess.run(['cargo','test','--manifest-path','packages/desktop/src-tauri/Cargo.toml','inspection::tests::initial_git_status_does_not_execute_repository_filters','--lib'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 Path('/tmp/w3-filter-mutation.log').write_text(result.stdout)
 assert result.returncode!=0 and 'Repository-configured command executed on the host' in result.stdout, result.stdout
 print('EXPECTED FAILURE: replacing libgit2 with git status executes the repository filter sentinel, even with core.fsmonitor=false and empty core.hooksPath.')
 print('test result: FAILED. 0 passed; 1 failed (mutation variant only).')
finally:
 p.write_text(original)
 print('Restored production libgit2 implementation byte-for-byte.')
