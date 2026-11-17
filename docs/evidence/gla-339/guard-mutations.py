"""Run the behavioral guards against deliberate regressions; always restore production source."""
import json
import os
from pathlib import Path
import subprocess

root = Path(os.environ['REPO_ROOT']).resolve()
source = root / 'packages/app/src/components/refetch-button.tsx'
original = source.read_text()
out = Path(__file__).resolve().parent
mutations = {
    'no-paint-barrier': ('await paintPending(() => setPending(true));', 'setPending(true);'),
    'native-disabled': ('aria-disabled={busy || disabled || props[\'aria-disabled\']}', 'disabled={busy} aria-disabled={busy || disabled || props[\'aria-disabled\']}'),
}
results = []
try:
    for name, (before, after) in mutations.items():
        assert before in original
        source.write_text(original.replace(before, after))
        result = subprocess.run(['pnpm', '--filter', '@appliance.sh/app', 'exec', 'vitest', 'run', 'src/components/refetch-button.test.tsx'], cwd=root, capture_output=True, text=True)
        (out / (name + '.txt')).write_text(result.stdout + result.stderr)
        results.append({'mutation': name, 'exit': result.returncode})
        assert result.returncode != 0, name + ' survived'
finally:
    source.write_text(original)
(out / 'guard-mutations.json').write_text(json.dumps(results, indent=2) + '\n')
