"""Scan tracked and untracked repository files; ignored dependencies/build outputs are excluded."""
import getpass
import json
import os
from pathlib import Path
import re
import subprocess

base = os.environ.get('PATH_SCAN_BASE')
output = os.environ.get('PATH_SCAN_OUTPUT')
if not base or not output:
    raise SystemExit('Set PATH_SCAN_BASE (pre-scrub revision) and PATH_SCAN_OUTPUT')
# Retain independently searchable IDs from historical evidence, not only full paths.
history = subprocess.run(['git', 'grep', '-I', '-h', '-E', '/var/folders/', base, '--', 'docs'], capture_output=True, text=True).stdout
ids = sorted(set(re.findall(r'/var/folders/([^/\s]+)/([^/\s]+)', history)))
identifiers = sorted({part for pair in ids for part in pair if part})
patterns = {
    'macOS home prefix': re.compile('/Users/'),
    'Unix home prefix': re.compile('/home/'),
    'macOS temp prefix': re.compile('/var/folders'),
    'private var prefix': re.compile('/private/var'),
    'Claude temp prefix': re.compile('/tmp/claude'),
    'runtime username': re.compile(re.escape(getpass.getuser()), re.I),
    'historical temp directory IDs': re.compile(r'(?<![a-zA-Z0-9_])(?:' + '|'.join(map(re.escape, identifiers)) + r')(?![a-zA-Z0-9_])') if identifiers else re.compile(r'(?!)'),
    'worktree thread IDs': re.compile(r'thr_[a-z0-9]+(?:-\d+)?'),
}
files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0')
remaining = []
for file in sorted(set(files) - {output, ''}):
    path = Path(file)
    if not path.is_file():
        continue
    for number, line in enumerate(path.read_bytes().decode('utf8', errors='replace').splitlines(), 1):
        for name, pattern in patterns.items():
            count = len(pattern.findall(line))
            if count:
                remaining.append({'file': file, 'line': number, 'pattern': name, 'matches': count})
# Classify short-ID byte matches in PNGs without treating compressed bytes as rendered text.
png_idat_matches = 0
for file in {row['file'] for row in remaining if row['file'].endswith('.png')}:
    data = Path(file).read_bytes()
    offset = 8
    while offset < len(data):
        length = int.from_bytes(data[offset:offset + 4], 'big')
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + length].decode('utf8', errors='replace')
        count = len(patterns['historical temp directory IDs'].findall(chunk))
        if count:
            assert kind == b'IDAT', 'Review identifying-pattern match outside PNG compressed image data'
            png_idat_matches += count
        offset += length + 12
# Positive controls prove every detector can find its target; no identifying values are persisted.
for name, pattern in patterns.items():
    if name == 'historical temp directory IDs':
        assert identifiers and all(pattern.search(value) for value in identifiers)
    elif name == 'runtime username':
        assert pattern.search(getpass.getuser())
    elif name == 'worktree thread IDs':
        assert pattern.search('thr_control123-1')
    else:
        assert pattern.search(pattern.pattern)
result = {'scope': 'All tracked and untracked repository files (including binary bytes); git-ignored dependency/build/cache trees excluded. Report file excluded to avoid recursive self-counting.', 'patterns': list(patterns), 'historicalTempIdsChecked': len(identifiers), 'matchesRemaining': sum(row['matches'] for row in remaining), 'pngCompressedByteMatches': png_idat_matches, 'imageLimit': 'PNG bytes are scanned, not OCR of rendered pixels', 'positiveControls': 'all detectors passed', 'remaining': remaining}
Path(output).write_text(json.dumps(result, indent=2) + '\n')
print(f"Scanned for {', '.join(patterns)}; {result['matchesRemaining']} matches remain (listed in {output}).")
