"""Inject slow signout work, compare frozen clock with original wall clock, restore."""
from pathlib import Path
import subprocess

path = Path('packages/credhelper/src/able/tests.rs')
original = path.read_text()
start = original.index('fn signout_cancels_pending_login_before_callback_commit()')
end = original.index('\n#[test]', start)
fixture = original[start:end].replace('account.sign_out().unwrap();', 'account.sign_out().unwrap();\n            std::thread::sleep(Duration::from_millis(1100));')
try:
    for mode in ('wall', 'frozen'):
        test = fixture.replace('|| start,', 'Instant::now,') if mode == 'wall' else fixture
        path.write_text(original[:start] + test + original[end:])
        code = subprocess.call(['python3', 'docs/evidence/gla-340/run.py', f'docs/evidence/gla-340/cancellation-{mode}.txt', 'cargo', 'test', '--manifest-path', 'packages/credhelper/Cargo.toml', 'signout_cancels_pending_login_before_callback_commit'])
        print(f'{mode} clock, 1100ms injected signout delay: exit {code}', flush=True)
        if (mode == 'wall' and code == 0) or (mode == 'frozen' and code != 0):
            raise RuntimeError('negative/positive control did not give expected result')
finally:
    path.write_text(original)
