"""Opt-in stdin filter: scrub before redirecting subprocess output into evidence."""
import getpass
import os
import re
import sys

if os.environ.get('EVIDENCE_SCRUB') != '1':
    raise SystemExit('Set EVIDENCE_SCRUB=1')
for line in sys.stdin:
    line = re.sub(r'(?:/private)?/var/folders/[^\s\x1b\"\x27)]+', '<temp>', line)
    line = re.sub(r'/(?:Users|home)/[^/\s]+', '<home>', line)
    line = re.sub(r'/tmp/claude[^\s\"\x27)]*', '<temp>', line)
    line = re.sub(r'thr_[a-z0-9]+(?:-\d+)?', '<thread>', line)
    line = re.sub(re.escape(getpass.getuser()), '<user>', line, flags=re.I)
    print(line, end='', flush=True)
