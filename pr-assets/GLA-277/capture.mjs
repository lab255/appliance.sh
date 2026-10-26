import {chromium} from '/tmp/gla-275-tools/node_modules/playwright/index.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
const mode=process.argv[2]||'after', base='/tmp/gla277-captures';
const b=await chromium.launch({headless:true,executablePath:'/Users/eliot/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const p=await b.newPage({viewport:{width:1100,height:780},reducedMotion:mode==='reduced'?'reduce':'no-preference'});
p.on('pageerror',e=>console.log('PAGE ERROR',e.message));
await p.route('**/src/main.tsx',async route=>{const r=await route.fetch();let s=await r.text();const old='if (mockHostEnabled()) return createMockHost();';if(!s.includes(old))throw Error('transport injection missed');s=s.replace(old,`if (mockHostEnabled()) { const host = createMockHost(); host.terminal = {open: async () => ({id: crypto.randomUUID(), write: async()=>{},resize: async()=>{},close: async()=>{}})}; return host; }`);await route.fulfill({response:r,body:s});});
await p.goto('http://localhost:41779/?mock-host&scenario=developer-mode');await p.waitForTimeout(1600);await p.evaluate(()=>document.fonts.ready);
async function startMeasure(kind){await p.evaluate(kind=>{
 const elements=kind==='sidebar'?Array.from(document.querySelectorAll('nav a')).flatMap(e=>[e,e.querySelector('.weight-label')||e.querySelector('span')]).filter(Boolean):Array.from(document.querySelectorAll('[data-terminal-tab]')).flatMap(e=>[e.parentElement,e,e.nextElementSibling]);
 const baseline=elements.map(e=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width}));
 window.samples=[];window.record=true;function frame(t){window.samples.push({t,geometry:elements.map((e,i)=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,dx:e.getBoundingClientRect().x-baseline[i].x,dw:e.getBoundingClientRect().width-baseline[i].width})),weights:Array.from(document.querySelectorAll('.weight-label-text')).map(e=>({text:e.textContent,wght:getComputedStyle(e).fontVariationSettings,duration:getComputedStyle(e).transitionDuration,opsz:getComputedStyle(e).fontOpticalSizing}))});if(window.record)requestAnimationFrame(frame)}requestAnimationFrame(frame);
 },kind)}
async function finishMeasure(name){const result=await p.evaluate(()=>{window.record=false;return window.samples});writeFileSync(`${base}/${mode}-${name}-samples.json`,JSON.stringify(result,null,2));if(mode!=='before'){const max=Math.max(...result.flatMap(s=>s.geometry.flatMap(g=>[Math.abs(g.dx),Math.abs(g.dw)])));console.log(name,'max layout delta',max);if(max!==0)throw Error('REFLOW '+max);}return result;}
async function frames(name,actions){const dir=`${base}/${mode}-${name}`;mkdirSync(dir,{recursive:true});let i=0;for(const action of actions){await action();for(let j=0;j<8;j++){await p.screenshot({path:`${dir}/${String(i++).padStart(3,'0')}.png`});await p.waitForTimeout(30);}}}
await startMeasure('sidebar');
await frames('sidebar',['Projects','Agents','Settings','Machine'].map(name=>()=>p.locator('nav').getByRole('link',{name,exact:true}).click()));
await finishMeasure('sidebar');
await p.getByRole('button',{name:'Open a shell',exact:true}).click();await p.waitForTimeout(200);
await p.getByRole('button',{name:'Hide',exact:true}).click();
await p.getByRole('button',{name:'Open another shell',exact:true}).click();await p.waitForTimeout(200);
await p.getByRole('button',{name:'Hide',exact:true}).click();
// Short distinct titles make following tab positions and status siblings easy to inspect.
for(const [i,title] of ['Build logs','Dev workspace'].entries()){
 await p.locator('[data-terminal-tab]').nth(i).press('F2');const input=p.getByRole('textbox',{name:'Rename terminal tab'});await input.fill(title);await input.press('Enter');
}
await p.waitForTimeout(200);await startMeasure('tabs');
await frames('tabs',[0,1,0,1].map(i=>()=>p.locator('[data-terminal-tab]').nth(i).click()));
const result=await finishMeasure('tabs');
if(mode==='after'){
 await p.evaluate(()=>{
 const tabs=Array.from(document.querySelectorAll('[data-terminal-tab]'));for(const tab of tabs){const r=tab.parentElement.getBoundingClientRect();const line=document.createElement('div');Object.assign(line.style,{position:'fixed',left:r.x+'px',top:'520px',height:'250px',borderLeft:'1px dashed #ffcc00',zIndex:'9999',pointerEvents:'none'});document.body.append(line);}
 const note=document.createElement('div');note.textContent='GLA-277 • 400 → 600 • 80ms • sibling Δx 0px • row Δwidth 0px';Object.assign(note.style,{position:'fixed',left:'300px',top:'530px',background:'#111',color:'#ffcc00',padding:'12px',zIndex:'9999',font:'14px monospace'});document.body.append(note);
 });await p.screenshot({path:`${base}/zero-shift-ruler.png`});
}
console.log('weights',JSON.stringify([...new Set(result.flatMap(s=>s.weights.map(w=>w.wght+' / '+w.duration+' / '+w.opsz)))]));
await b.close();
