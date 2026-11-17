"""Run evidence commands with paths scrubbed before writing output."""
import os
import re
import subprocess
import sys

output, *command = sys.argv[1:]
process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
with open(output, 'w') as log:
    log.write('Command: ' + ' '.join(command) + '\n')
    for line in process.stdout:
        line = re.sub(r'\x1b\[[0-9;]*m', '', line)
        line = line.replace(os.getcwd(), '<repo>').replace(os.path.expanduser('~'), '<home>')
        line = re.sub(r'(?:/private)?/var/folders/[^\s\x1b\"\']+', '<temp>', line)
        line = re.sub(r'(?:/private)?/tmp/[^\s\x1b\"\']+', '<temp>', line)
        line = re.sub(r'[A-Z]:\\(?:Users|a)\\[^\s\x1b\"\']+', '<windows-path>', line)
        line = re.sub(r'<home>/\.appliance/vm/[^\s\"\']+', '<runtime-test>', line)
        log.write(line)
        log.flush()
    code = process.wait()
    log.write(f'Exit: {code}\n')
print(f'{output}: exit {code}')
sys.exit(code)
