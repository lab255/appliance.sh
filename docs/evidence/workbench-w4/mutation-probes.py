"""Run from repository root. Temporarily restore each defect; always restore source."""
from pathlib import Path
import subprocess
import json
cases = [
 ('premature-observation-focus', 'packages/app/src/providers/terminal-sessions-provider.tsx', "if (!opts.background && opts.inputMode !== 'observe') term.focus();", 'if (!opts.background) term.focus();', 'src/providers/terminal-sessions-provider.test.tsx'),
 ('provider-write-gate', 'packages/app/src/providers/terminal-sessions-provider.tsx', "if (live.inputMode === 'interactive') void live.session?.write(d);", 'void live.session?.write(d);', 'src/providers/terminal-sessions-provider.test.tsx'),
 ('generated-hidden-count', 'packages/app/src/pages/workbench/workspace-inspector.tsx', 'const hiddenChanges = generated', 'const hiddenChanges = true', 'src/pages/workbench/workspace-inspector.test.tsx'),
 ('stale-clean-comparison', 'packages/app/src/pages/workbench/workspace-inspector.tsx', '!!snapshot.comparisonError || !!error', '!!snapshot.comparisonError', 'src/pages/workbench/workspace-inspector.test.tsx'),
 ('dropped-directory-prop', 'packages/app/src/pages/workbench/detail.tsx', '<WorkspaceInspector directory={workspace.directory}', '<WorkspaceInspector directory="/wrong-folder"', 'src/pages/workbench/workspace-inspector.test.tsx'),
]
results = []
for name, filename, before, after, test in cases:
 p = Path(filename); source = p.read_text()
 assert before in source, name
 try:
  p.write_text(source.replace(before, after, 1))
  run = subprocess.run(['pnpm', '--filter', '@appliance.sh/app', 'exec', 'vitest', 'run', test], capture_output=True, text=True)
  Path(f'docs/evidence/workbench-w4/{name}.txt').write_text(run.stdout + run.stderr)
  results.append({'mutation': name, 'exit': run.returncode, 'detected': run.returncode != 0})
 finally:
  p.write_text(source)
Path('docs/evidence/workbench-w4/mutations.json').write_text(json.dumps(results, indent=2)+'\n')
assert all(result['detected'] for result in results)
