"""Run the behavioral guards against deliberate regressions; always restore production source."""
import json
import os
from pathlib import Path
import subprocess

repo_root = os.environ.get('REPO_ROOT')
if not repo_root:
    raise SystemExit('Set REPO_ROOT to the repository checkout before running guard mutations.')
root = Path(repo_root).resolve()
source = root / 'packages/app/src/components/refetch-button.tsx'
original = source.read_text()
out = Path(__file__).resolve().parent
mutations = {
    'no-composed-click': ('onClick?.(event);', ''),
    'no-repeat-guard': ("if (busy || disabled || props['aria-disabled'] === true || props['aria-disabled'] === 'true') return;", ''),
    'no-paint-barrier': ('await paintPending(() => setPending(true));', 'setPending(true);'),
    'native-disabled': ('aria-disabled={busy || disabled || props[\'aria-disabled\']}', 'disabled={busy} aria-disabled={busy || disabled || props[\'aria-disabled\']}'),
}
results = []
try:
    for name, (before, after) in mutations.items():
        assert before in original
        source.write_text(original.replace(before, after))
        result = subprocess.run(['pnpm', '--filter', '@appliance.sh/app', 'exec', 'vitest', 'run', 'src/components/refetch-button.test.tsx'], cwd=root, capture_output=True, text=True)
        log = (result.stdout + result.stderr).replace(str(root), '<repo>').replace(str(Path.home()), '<repo>')
        (out / (name + '.txt')).write_text('\n'.join(line.rstrip() for line in log.splitlines()) + '\n')
        results.append({'mutation': name, 'exit': result.returncode})
        assert result.returncode != 0, name + ' survived'
finally:
    source.write_text(original)
(out / 'guard-mutations.json').write_text(json.dumps(results, indent=2) + '\n')
