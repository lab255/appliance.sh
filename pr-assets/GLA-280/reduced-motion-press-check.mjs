const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH});
const results=[];
try {
 for (const version of ['8730c90','revision']) {
  const css=version==='revision'?readFileSync('packages/ui/src/styles.css','utf8'):execFileSync('git',['show','8730c90:packages/ui/src/styles.css'],{encoding:'utf8'});
  const page=await browser.newPage({reducedMotion:'reduce'});
  await page.setContent(`<style>:root{--color-hover:rgb(26,26,26);--color-active:rgb(36,36,36)}button{width:200px;height:40px;background:transparent}[data-hover-glide-press-fill]:active{background:var(--color-active)}${css}</style><nav data-hover-glide="immediate" class="hover-glide"><button data-hover-glide-item>Ordinary row</button><button data-hover-glide-item data-hover-glide-press-fill>Explicit press fill</button></nav>`);
  for(const index of [0,1]) {
   const row=page.locator('button').nth(index);await row.hover();await page.mouse.down();
   const color=await row.evaluate(e=>getComputedStyle(e).backgroundColor);
   results.push({version,row:index===0?'ordinary':'explicit press fill',reducedMotion:true,pressed:true,color});
   const expected=index===1?'rgb(36, 36, 36)':version==='revision'?'rgb(26, 26, 26)':'rgba(0, 0, 0, 0)';
   if(color!==expected)throw Error(JSON.stringify({version,index,color,expected}));
   await page.mouse.up();
  }
  await page.close();
 }
 writeFileSync(process.argv[2] ?? 'reduced-motion-press-regression.json',JSON.stringify({method:'Chromium, actual source CSS from 8730c90 and revision; synthetic ordinary/explicit-fill rows; reduced-motion media; real pointer down. Tokens and explicit fill declared in fixture.',results},null,2));
 console.log(JSON.stringify(results,null,2));
}finally{await browser.close()}
