import {chromium} from '/tmp/gla282-tools/node_modules/playwright/index.mjs';
import {GIFEncoder,quantize,applyPalette} from '/tmp/gla276-tools/node_modules/gifenc/dist/gifenc.esm.js';
import png from '/tmp/gla276-tools/node_modules/pngjs/lib/png.js';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const mode=process.argv[2], out='/tmp/gla284/assets';
const browser=await chromium.launch({headless:true,executablePath:'/Users/eliot/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
try {
const page=await browser.newPage({viewport:{width:1100,height:780},deviceScaleFactor:1});
await page.goto('http://127.0.0.1:41784/?mock-host&scenario=developer-mode');
await page.getByRole('button',{name:'Re-run checks'}).waitFor();
await page.evaluate(()=>document.fonts.ready); await page.waitForTimeout(600);
const traces={mode,viewport:{width:1100,height:780,dpr:1},scenarios:{}};
await page.evaluate(()=>{const dot=document.createElement('div');dot.id='capture-pointer';dot.style.cssText='position:fixed;width:5px;height:5px;border-radius:50%;background:white;outline:1px solid black;z-index:99999;pointer-events:none;left:-20px';document.body.append(dot);window.addEventListener('pointermove',e=>{dot.style.left=`${e.clientX-2}px`;dot.style.top=`${e.clientY-2}px`;window.capturePointer={x:e.clientX,y:e.clientY};});});
async function start(){await page.evaluate(()=>{window.trace=[];window.tracing=true;const start=performance.now();function sample(){if(!window.tracing)return;const h=document.querySelector('[data-hover-glide-highlight]');const p=window.capturePointer;const target=p?document.elementFromPoint(p.x,p.y)?.closest('[data-hover-glide-item]'):null;window.trace.push({ms:performance.now()-start,pointer:p,target:target?.textContent??null,active:target?.getAttribute('aria-current'),highlight:h?{opacity:getComputedStyle(h).opacity,rect:h.getBoundingClientRect().toJSON(),transform:getComputedStyle(h).transform}:null});requestAnimationFrame(sample);}requestAnimationFrame(sample);});}
async function stop(name){traces.scenarios[name]=await page.evaluate(()=>{window.tracing=false;return window.trace;});}
async function gif(name,from,to,step,delay){await page.mouse.move(400,400);await page.waitForTimeout(150);await page.mouse.move(110,from);await page.waitForTimeout(200);const frames=[];await start();for(let y=from;y<=to;y+=step){await page.mouse.move(110,y);await page.waitForTimeout(delay);const buf=await page.screenshot({clip:{x:0,y:160,width:440,height:220}});frames.push({buf,time:Date.now()});}await stop(name);const gif=GIFEncoder();for(let i=0;i<frames.length;i++){const im=png.PNG.sync.read(frames[i].buf),palette=quantize(im.data,256),index=applyPalette(im.data,palette);gif.writeFrame(index,im.width,im.height,{palette,delay:i===frames.length-1?400:Math.max(10,Math.round((frames[i+1].time-frames[i].time)/10)*10)});}gif.finish();writeFileSync(`${out}/${mode}-${name}.gif`,gif.bytes());traces[`${name}AcquisitionMs`]=frames.at(-1).time-frames[0].time;}
await gif('gaps-slow',221,255,1,35);
await gif('gaps-normal',221,257,6,10);
await gif('active-crossing',255,323,2,20);
await page.mouse.move(110,221);await page.waitForTimeout(250);await page.mouse.move(110,238);await start();await page.waitForTimeout(300);await stop('gapHold');
if(mode==='after')assert(traces.scenarios.gapHold.every(s=>s.highlight?.opacity==='1'&&Math.abs(s.highlight.rect.y-205)<.1));
await page.mouse.move(110,255);await page.waitForTimeout(250);await page.mouse.move(110,289);await start();await page.waitForTimeout(300);await stop('activeHold');
if(mode==='after')assert(traces.scenarios.activeHold.every(s=>s.highlight?.opacity==='1'&&Math.abs(s.highlight.rect.y-239)<.1));
await page.mouse.move(400,400);await page.waitForTimeout(150);assert.equal(await page.locator('[data-hover-glide-highlight]').count(),0);
const button=page.getByRole('button',{name:'Re-run checks'}), b=await button.boundingBox();const clip={x:Math.max(0,Math.min(660,Math.floor(b.x-80))),y:Math.floor(b.y-35),width:440,height:110};
for(const state of ['rest','hover','press']){if(state==='hover')await button.hover();if(state==='press')await page.mouse.down();await page.waitForTimeout(200);traces[`button-${state}`]=await button.evaluate(e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,transform:getComputedStyle(e).transform,transition:getComputedStyle(e).transitionProperty}));await page.screenshot({path:`${out}/${mode}-ghost-${state}.png`,clip});}await page.mouse.up();
await page.emulateMedia({reducedMotion:'reduce'});await page.mouse.move(110,221);await page.waitForTimeout(100);assert.equal(await page.locator('[data-hover-glide-highlight]').count(),0);traces.reducedMotion='no layer';
writeFileSync(`${out}/${mode}-raf-trace.json`,JSON.stringify(traces,null,2));console.log(mode,JSON.stringify({slow:traces['gaps-slowAcquisitionMs'],normal:traces['gaps-normalAcquisitionMs'],button:traces['button-hover']}));
} finally {await browser.close();}
