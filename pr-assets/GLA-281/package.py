from pathlib import Path
from PIL import Image
import json,csv,shutil
src=Path('/private/tmp/gla281-evidence');out=Path('/private/tmp/appliance-gla281-artifacts/pr-assets/GLA-281');out.mkdir(parents=True,exist_ok=True)
rows=[]
for stage in ['before','after']:
 for name in ['dialog','confirm','tooltip','popover','menu']:
  for mode in ['full','interrupt']:
   stem=f'{stage}-{name}-{mode}';frames=[Image.open(p).convert('RGB') for p in sorted((src/stem).glob('*.png'))]
   frames[0].save(out/f'{stem}.gif',save_all=True,append_images=frames[1:],duration=100 if stage=='before' else 800,loop=0)
   shutil.copy(src/f'{stem}.json',out/f'{stem}.json')
   if mode=='full':
    samples=json.loads((src/f'{stem}.json').read_text())['samples'];opened=[x for x in samples if x.get('state') in ['open','delayed-open','instant-open']];closed=[x for x in samples if x.get('state')=='closed'];settled=next((x for x in opened if float(x['opacity'])>=.999),None);gone=next((x for x in samples if closed and x['t']>closed[-1]['t'] and x['opacity'] is None),None);factor=10 if stage=='before' else 1
    rows.append([stage,name,round((settled['t']-opened[0]['t'])/factor,1) if settled else '',round((gone['t']-closed[0]['t'])/factor,1) if gone else ''])
with (out/'measured-times.csv').open('w') as f:
 w=csv.writer(f);w.writerow(['stage','surface','observed_enter_to_opacity_0.999_ms','observed_exit_to_unmount_ms']);w.writerows(rows)
for name in ['capture.cjs','check.cjs','harness.tsx','harness.html']:
 shutil.copy(Path('/private/tmp/gla281-tools')/name,out/name)
shutil.copy(src/'browser-check.txt',out/'browser-check.txt')
print(rows)
