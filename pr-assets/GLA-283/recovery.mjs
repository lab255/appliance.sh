import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import gifenc from 'gifenc';
import fs from 'node:fs';
const {GIFEncoder,quantize,applyPalette}=gifenc;
const phase=process.argv[2]||'before';
const out='/tmp/gla283-capture/'+phase; fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Users/eliot/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const date='2026-10-26T12:00:00.000Z';
const project={id:'p1',name:'Notes',description:'Team notes',status:'active',createdAt:date,updatedAt:date};
const env={id:'e1',projectId:'p1',name:'production',status:'deployed',createdAt:date,updatedAt:date,lastDeployedAt:date,url:'https://notes.example.test'};
const deploy={id:'d1',projectId:'p1',environmentId:'e1',action:'deploy',status:'succeeded',startedAt:date,completedAt:date,message:'Deployment complete'};
const unusedCases=[['project','/projects/p1'],['deployment','/deployments/d1'],['environment','/projects/p1/environments/e1'],['deployments','/deployments'],['apps','/projects'],['agents','/agents'],['machine','/machine'],['settings','/settings']];
const cases=[['account-retry','/settings'],['entitlements-retry','/settings'],['team-retry','/settings'],['apps-retry','/projects'],['credentials-retry','/machine','Credentials'],['egress-retry','/machine','Egress']];
const selected=process.argv[3]?.split(',');
const measurementFile=out+'/recovery-measurements.json';
const results=selected && fs.existsSync(measurementFile)?JSON.parse(fs.readFileSync(measurementFile)).filter(r=>!selected.includes(r.name)):[];
for(const [name,path,tab] of cases.filter(([name])=>!selected||selected.includes(name))){ let apiFailure=true;
 const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});
 await context.addInitScript(()=>{sessionStorage.setItem('mock-host:clusters',JSON.stringify({clusters:[{id:'capture',name:'Capture target',apiServerUrl:'https://capture.example.test',createdAt:'2026-10-26T12:00:00.000Z',apiKey:{id:'mock',secret:'mock-secret'}}],selectedClusterId:'capture'}));});
 const page=await context.newPage(); await page.addInitScript(({name})=>{window.__captureFailure=true;window.__captureCase=name;},{name}); page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
 await page.route('**/src/main.tsx',async route=>{const r=await route.fetch(); let body=await r.text();body=body.replace('return createMockHost();',`return (()=>{
 const cache=new WeakMap();
 const wrap=(o,p='')=>{
  if(cache.has(o)) return cache.get(o);
  const methods=new Map();
  const proxy=new Proxy(o,{get(t,k){
   const v=t[k],path=p+'.'+String(k);
   if(typeof v==='function'){
    if(methods.has(k)) return methods.get(k);
    const fn=(...a)=>{
     const invoke=()=>{
      const c=window.__captureCase;
      if(window.__captureFailure&&((c==='account-retry'&&path.endsWith('.account.status'))||(c==='entitlements-retry'&&path.endsWith('.entitlements.suggestions'))||(c==='credentials-retry'&&path.endsWith('.creds.list'))||(c==='egress-retry'&&path.endsWith('.egress.get')))) return Promise.reject(new Error('Capture: host read unavailable'));
      return v.apply(t,a);
     };
     if(['status','list','get','suggestions'].includes(String(k))) return new Promise(r=>setTimeout(r,800)).then(invoke);
     const result=invoke();return result&&typeof result==='object'&&!(result instanceof Promise)?wrap(result,path):result;
    };methods.set(k,fn);return fn;
   }
   return v&&typeof v==='object'?wrap(v,path):v;
  }});cache.set(o,proxy);return proxy;
 };return wrap(createMockHost());})();`);await route.fulfill({response:r,body});});
 await page.route('https://capture.example.test/**',async route=>{const p=new URL(route.request().url()).pathname;let data={};
 if(p.endsWith('/health')) data={status:'healthy',readyReplicas:1,desiredReplicas:1,restarts:0,usage:{cpuMillicores:12,memoryBytes:10240000},pods:[]};
 else if(p.endsWith('/environments/e1'))data=env;
 else if(p.endsWith('/environments'))data=[env];
 else if(p.endsWith('/projects/p1'))data=project;
 else if(p.endsWith('/projects'))data=[project];
 else if(p.endsWith('/deployments/d1'))data=deploy;
 else if(p.endsWith('/deployments'))data=[deploy];
 else if(p.includes('whoami')||p.endsWith('/keys/self'))data={role:'admin',id:'self',name:'Avery'};
 else if(p.includes('/keys')||p.includes('/invites'))data=[];
 if(apiFailure && ((name==='apps-retry' && p.endsWith('/projects')) || (name==='team-retry' && (p.endsWith('/invites') || p.endsWith('/keys'))))) {await new Promise(r=>setTimeout(r,800));await route.fulfill({status:503,json:{error:'Capture: read unavailable'}});return;} await new Promise(r=>setTimeout(r,800)); await route.fulfill({json:data,headers:{'access-control-allow-origin':'*'}});
 });
 await page.goto('http://127.0.0.1:1420'+path+'?mock-host&scenario=developer-mode');
 await page.waitForTimeout(500); console.log((await page.locator('body').innerText()).slice(0,800)); await page.locator('main').waitFor();
 if(tab){await page.getByRole('tab',{name:tab,exact:true}).waitFor();await page.waitForTimeout(4000);await page.getByRole('tab',{name:tab,exact:true}).click();} await page.waitForTimeout(13000); if(name==='entitlements-retry') await page.getByText('Entitlements',{exact:true}).scrollIntoViewIfNeeded(); const frames=[],boxes=[];const start=Date.now();
 for(let i=0;i<25;i++){if(i===5){const retries=await page.getByRole('button',{name:/^Retry/}).elementHandles();if(retries.length){apiFailure=false;await page.evaluate(()=>window.__captureFailure=false);for(const retry of retries) await retry.click();}}boxes.push(await page.locator('main > div').first().boundingBox());frames.push(await page.screenshot());await page.waitForTimeout(200);}
 const gif=GIFEncoder(); for(const frame of frames){const p=PNG.sync.read(frame); const palette=quantize(p.data,128);gif.writeFrame(applyPalette(p.data,palette),p.width,p.height,{palette,delay:240});}gif.finish();fs.writeFileSync(out+'/'+name+'.gif',gif.bytes());
 const text=await page.locator('main').innerText();fs.writeFileSync(out+'/'+name+'.txt',text);
 const first=boxes[0],last=boxes.at(-1);results.push({name,first,last,delta:first&&last?Object.fromEntries(['x','y','width','height'].map(k=>[k,last[k]-first[k]])):null,boxes,duration:Date.now()-start});console.log(name,results.at(-1).delta,text.slice(0,100));await context.close();
}
fs.writeFileSync(out+'/recovery-measurements.json',JSON.stringify(results,null,2));await browser.close();
