#!/usr/bin/env node
// Browser DOM smoke for environments where HTTP and file:// navigation are
// disallowed. It executes the REAL application scripts with the original
// <script> order, replacing only the transport with inline static sources.
// Not a substitute for network E2E, SW/push or a physical iPhone.
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const site=path.join(root,'site');
let html=readFileSync(path.join(site,'index.html'),'utf8');
const template=JSON.parse(readFileSync(path.join(root,'private','schedule-template.v1.json'),'utf8'));
const payload={plans:template.plans,habits:template.habitList};
const escapeScript=s=>s.replace(/<\/script/gi,'<\\/script');
html=html.replace(/<link\s+rel="stylesheet"\s+href="([^"?]+)(?:\?[^\"]*)?"\s*\/?>/g,(match,filename)=>{
 try {return '<style>'+readFileSync(path.join(site,filename),'utf8')+'</style>'}catch{return match}
});
html=html.replace(/<script\s+src="([^"?]+)(?:\?[^\"]*)?"\s*><\/script>/g,(match,filename)=>{
 try{return '<script>'+escapeScript(readFileSync(path.join(site,filename),'utf8'))+'<\/script>'}catch{return match}
});
const chromiumPath=process.env.AUDIT_CHROMIUM||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
const browser=await chromium.launch({headless:true,...(chromiumPath?{executablePath:chromiumPath}:{}),args:['--no-sandbox']});
let cases=0;
try{
 for(const width of [375,390,430])for(const theme of ['light','dark']){
   const page=await browser.newPage({viewport:{width,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.evaluate(()=>{const state=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>state.get(k)??null,setItem:(k,v)=>state.set(String(k),String(v)),removeItem:k=>state.delete(k),clear:()=>state.clear()}})});
   await page.evaluate(p=>{localStorage.setItem('jarvis_schedule_template_v1',JSON.stringify({version:1,payload:p}));},payload);
   await page.evaluate(t=>{localStorage.setItem('jarvis_ui_theme',t)},theme);
   await page.setContent(html,{waitUntil:'load'});
   if((await page.locator('#app').innerText()).length<20)throw Error('empty app');
   const tabs=['today','planner','ai','more'];
   for(const tab of tabs){
     await page.locator(`[data-action="tab"][data-tab="${tab}"]`).first().click();
     const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,visible:window.innerWidth}));
     if(layout.scroll>layout.visible+2)throw Error(`horizontal overflow ${width}/${theme}/${tab} ${JSON.stringify(layout)}`);
     if((await page.locator('#app').innerText()).length<15)throw Error(`empty ${tab}`);
     cases++;
   }
   if(errors.length)throw Error(`JavaScript exceptions ${width}/${theme}: ${errors.slice(0,2).join('; ')}`);
   await page.close();
 }
 console.log(`PASS ${cases} real Chromium DOM tab transitions; 375/390/430 px × both themes; no page exceptions or overflow`);
}finally{await browser.close()}
