"""Run from repository root, with no dev server or verification using these files."""
from pathlib import Path
import subprocess
import json

base = Path('packages/app/src/pages/workbench')
mutants = [
    ('disconnected-detail', base / 'detail.tsx', 'readinessProposal={readinessProposal}', 'readinessProposal={null}'),
    ('lost-stale-semantics', base / 'package-section.tsx', ': readinessStaleReason(proposal)', ': undefined'),
    ('auto-package-on-proposal', base / 'package-section.tsx', '  async function packageFromClick() {', '  React.useEffect(() => { if (proposal) void packageFromClick(); }, [proposal]);\n  async function packageFromClick() {'),
    ('source-directory-guard', Path('packages/app/src/lib/workbench-readiness.ts'), " && proposal.directory === directory", ""),
    ('package-directory-guard', base / 'package-section.tsx', 'readinessProposal?.directory === directory ? readinessProposal : null', 'readinessProposal'),
    ('dismiss-stale-guard', base / 'package-section.tsx', 'if (!staleReason) setDismissed', 'setDismissed'),
]
results = []
for name, path, old, new in mutants:
    original = path.read_text()
    assert old in original
    try:
        path.write_text(original.replace(old, new, 1))
        run = subprocess.run(['pnpm', '--filter', '@appliance.sh/app', 'exec', 'vitest', 'run', 'src/pages/workbench/readiness.test.tsx', 'src/pages/workbench/package-section.test.tsx'], capture_output=True, text=True)
        lines = [line for line in (run.stdout + run.stderr).splitlines() if 'AssertionError:' in line or 'Tests ' in line or 'Test Files' in line]
        results.append({'mutant': name, 'exitCode': run.returncode, 'evidence': lines})
        assert run.returncode != 0, name + ' survived'
    finally:
        path.write_text(original)
run = subprocess.run(['pnpm', '--filter', '@appliance.sh/app', 'exec', 'vitest', 'run', 'src/pages/workbench/readiness.test.tsx', 'src/pages/workbench/package-section.test.tsx'], capture_output=True, text=True)
results.append({'mutant': 'restored-final-source', 'exitCode': run.returncode, 'evidence': [line for line in run.stdout.splitlines() if 'Tests ' in line or 'Test Files' in line]})
Path('docs/evidence/workbench-w5/teeth.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
assert run.returncode == 0
