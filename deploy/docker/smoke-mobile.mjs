/** Mobile layout regression gate. Run against disposable data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const data = process.env.LH_DATA_DIR;
assert(data && fs.realpathSync(data).startsWith('/tmp/'), 'Use a disposable /tmp learning profile');
const base = process.env.LH_SMOKE_URL ?? 'http://127.0.0.1:3000';
const evidence = process.env.LH_EVIDENCE ?? fs.mkdtempSync(path.join(os.tmpdir(),'lh-mobile-browser-'));
fs.mkdirSync(evidence,{recursive:true});
const require = createRequire(process.env.LH_RUNTIME_ROOT ?? '/app/server.js');
const puppeteer = require('puppeteer-core');
const json = async (route,init) => {const r=await fetch(base+route,init);assert.equal(r.status,200,route);return r.json()};
const chat=await json('/api/chats',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Mobile scroll fixture'})});
const file=path.join(data,'chats',chat.id+'.json');
const record=JSON.parse(fs.readFileSync(file));
record.messages=[{id:'mobile-user',role:'user',content:[{type:'text',text:'Show a question'}],timestamp:Date.now()},{id:'mobile-assistant',role:'assistant',api:'openai-responses',provider:'openai',model:'fixture',stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},content:[{type:'toolCall',id:'mobile-question',name:'ask_user_question',arguments:{question:'Which option keeps this question visible?',options:Array.from({length:12},(_,i)=>({label:'Option '+i+' '+('Long answer text for independent scrolling. '.repeat(9))}))}}]}];
fs.writeFileSync(file,JSON.stringify(record));
const catalog=await json('/api/models');
const settings=await json('/api/settings');
if(settings.settings?.models?.strong?.model)settings.settings.models.strong.model.id='very-long-model-name-with-a-descriptive-version-and-configuration';
if(catalog.slots?.strong?.model)catalog.slots.strong.model.id='very-long-model-name-with-a-descriptive-version-and-configuration';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH ?? '/usr/bin/chromium',headless:true,args:['--disable-dev-shm-usage']});
const results=[];
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 // Persistent event streams and background polling do not imply layout work.
 // Observe the actual dock until metadata and its resize animation settle.
 const settle=async()=>{
  await page.waitForFunction(()=>{
   const prompt=document.querySelector('[data-testid="question-prompt"]');
   const bar=document.querySelector('[data-testid="stats-bar"]');
   if(!prompt || !bar)return false;
   const r=prompt.getBoundingClientRect(), b=bar.getBoundingClientRect();
   const signature=[r.top,r.height,b.top,b.height].map(n=>n.toFixed(2)).join('/');
   if(window.mobileDockGeometry?.signature!==signature)window.mobileDockGeometry={signature,changed:performance.now()};
   return performance.now()-window.mobileDockGeometry.changed>500;
  });
 };
 await page.setRequestInterception(true);
 page.on('request',request=>{
  const url=new URL(request.url());
  if(url.origin===new URL(base).origin && url.pathname==='/api/settings' && request.method()==='GET')return void request.respond({status:200,contentType:'application/json',body:JSON.stringify(settings)});
  if(url.origin===new URL(base).origin && url.pathname==='/api/models' && request.method()==='GET')return void request.respond({status:200,contentType:'application/json',body:JSON.stringify(catalog)});
  if(url.origin===new URL(base).origin && url.pathname==='/api/connections/chatgpt' && request.method()==='GET')return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({available:true,pending:false,allowBackgroundUse:false,activeId:'fixture',accounts:[{id:'fixture',email:'a-long-account-name-for-phone-layout@example.invalid',registration:'fixture',connected:true}],error:null})});
  void request.continue();
 });
 const go=async route=>{await page.goto(base+route,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForSelector('[aria-label="Open sidebar"]');await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--mobile-viewport-height')!=='');await page.addStyleTag({content:'nextjs-portal{display:none!important}'});};
 const fit=async (selector,width,height)=>{
  const r=await page.$eval(selector,e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});
  assert(r.left>=-1 && r.right<=width+1 && r.top>=-1 && r.bottom<=height+1,selector+': '+JSON.stringify(r));return r;
 };
 for(const [width,height] of [[320,568],[390,844],[430,932],[740,390],[1280,900]]){
  const mobile=width<768;await page.setViewport({width,height,isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});
  await go('/');await page.evaluate(()=>localStorage.setItem('lh:sidebar-open','1'));await go('/');
  if(mobile){
   await page.waitForFunction(()=>!document.querySelector('[data-testid="desktop-sidebar"]'));
   assert.equal(await page.$('[data-testid="mobile-sidebar"]'),null,'Phone starts closed despite desktop preference');
   const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.deepEqual(geometry,{width,scroll:width});
   const content=await fit('.app-content',width,height);assert.equal(Math.round(content.right-content.left),width);
   await page.waitForFunction(()=>document.querySelector('[data-testid="stats-model"]')?.textContent.includes('very-long-model'));
   await fit('[data-testid="stats-bar"]',width,height);await fit('[data-testid="stats-model"]',width,height);
   const inputFont=await page.$eval('[data-attachment-composer] .lh-input',e=>getComputedStyle(e).fontSize);assert.equal(inputFont,'16px');
   await page.screenshot({path:path.join(evidence,`home-${width}.png`)});
   await page.tap('[aria-label="Open sidebar"]');await page.waitForSelector('[data-testid="mobile-sidebar"]');
   await page.waitForFunction(()=>document.querySelector('[data-testid="mobile-sidebar"]')?.getAttribute('aria-busy')!=='true');
   await fit('[data-testid="mobile-sidebar"]',width,height);
   await page.waitForFunction(()=>document.querySelector('[role="dialog"][aria-label="Navigation"]')?.getAttribute('aria-modal')==='true' && document.activeElement?.closest('[role="dialog"][aria-label="Navigation"]'));
   await page.hover('[data-testid="mobile-sidebar"]');
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const touch=await page.createCDPSession();
   for(let attempt=0;attempt<8;attempt++){
    const end=await page.$eval('[data-testid="mobile-sidebar"] > div',e=>e.scrollHeight-e.clientHeight-e.scrollTop<2);
    if(end)break;
    const start=height-80, finish=80;
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:start}]});
    for(let step=1;step<=8;step++){
     await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y:start+(finish-start)*step/8}]});
     await new Promise(resolve=>setTimeout(resolve,25));
    }
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   await touch.detach();
   await page.waitForFunction(()=>{const e=document.querySelector('[data-testid="mobile-sidebar"] > div');return e.scrollHeight<=e.clientHeight || e.scrollTop>0});
   await fit('[data-testid="settings-entry"]',width,height);
   await fit('[aria-label="Close sidebar"]',width,height);
   assert.equal(await page.$eval('.app-content',e=>Math.round(e.getBoundingClientRect().width)),width,'Drawer does not squeeze content');
   assert.equal(await page.evaluate(()=>localStorage.getItem('lh:sidebar-open')),'1');
   await page.keyboard.press('Tab');assert(await page.evaluate(()=>!!document.activeElement.closest('[role="dialog"][aria-label="Navigation"]')),'Focus stays in drawer');
   await page.keyboard.press('Escape');await page.waitForSelector('[data-testid="mobile-sidebar"]',{hidden:true});
   await page.tap('[aria-label="Open sidebar"]');await page.waitForSelector('[data-testid="mobile-sidebar"]');
   await page.touchscreen.tap(width-8,Math.floor(height/2));await page.waitForSelector('[data-testid="mobile-sidebar"]',{hidden:true});
   await page.tap('[aria-label="Open sidebar"]');await page.waitForSelector('[data-testid="mobile-sidebar"]');
   await page.tap('[data-testid="new-session"]');await page.waitForSelector('[data-testid="mobile-sidebar"]',{hidden:true});
   await page.waitForFunction(()=>location.pathname==='/chat/new');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,'New session fits');
   await page.tap('[aria-label="Open sidebar"]');await page.tap('[data-testid="settings-entry"]');await page.waitForSelector('[data-testid="settings-dialog"]');
   assert.equal(await page.$('[data-testid="mobile-sidebar"]'),null);
   await fit('[data-testid="settings-dialog"]',width,height);await fit('[data-testid="settings-close"]',width,height);
   const sections=await page.$$eval('[data-testid="settings-mobile-section"] option',nodes=>nodes.map(n=>n.value));
   for(const section of sections){
    await page.select('[data-testid="settings-mobile-section"]',section);
    await new Promise(resolve=>setTimeout(resolve,150));
    if(section==='keys')await page.waitForSelector('[data-testid="chatgpt-connection"]');
    const overflow=await page.$eval('[data-testid="settings-content"]',e=>({width:e.clientWidth,scroll:e.scrollWidth}));
    assert(overflow.scroll<=overflow.width+1,`Settings ${section} at ${width}px: `+JSON.stringify(overflow));
   }
   await page.select('[data-testid="settings-mobile-section"]','keys');await page.waitForSelector('[data-testid="chatgpt-connection"]');await page.screenshot({path:path.join(evidence,`settings-${width}.png`)});
   await page.tap('[data-testid="settings-close"]');
   await go('/chat/'+chat.id);await page.waitForSelector('[data-testid="question-options"]');await settle();
   const prompt=await fit('[data-testid="question-prompt"]',width,height);
   await page.$eval('[data-testid="question-options"]',e=>e.scrollTop=e.scrollHeight);
   assert.equal(await page.$eval('[data-testid="question-prompt"]',e=>e.getBoundingClientRect().top),prompt.top);
   await page.hover('[data-testid="question-options"]');await page.mouse.wheel({deltaY:600});
   assert(await page.$('[data-testid="question-options"]'),'Question stays expanded at option scroll edge');
   await page.screenshot({path:path.join(evidence,`question-${width}.png`)});
   if(width===390){
    await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:360});visualViewport.dispatchEvent(new Event('resize'));});
    await page.waitForFunction(()=>{const r=document.querySelector('[data-testid="question-prompt"]').getBoundingClientRect();return r.top>=0 && r.bottom<=360});
    const keyboardPrompt=await fit('[data-testid="question-prompt"]',width,360);
    assert(await page.$eval('[data-testid="question-options"]',e=>e.scrollHeight>e.clientHeight),'Options remain independently scrollable above the keyboard');
    await page.$eval('[data-testid="question-options"]',e=>e.scrollTop=0);
    assert.equal(await page.$eval('[data-testid="question-prompt"]',e=>e.getBoundingClientRect().top),keyboardPrompt.top);
    await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
    await go('/');
    await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:360});visualViewport.dispatchEvent(new Event('resize'));});
    await fit('[data-testid="stats-bar"]',width,360);
    await page.tap('[aria-label="Open sidebar"]');await page.tap('[data-testid="settings-entry"]');
    await fit('[data-testid="settings-dialog"]',width,360);
    await page.tap('[data-testid="settings-close"]');
    await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
   }
  }else{
   await page.waitForFunction(()=>Math.round(document.querySelector('[data-testid="desktop-sidebar"]')?.getBoundingClientRect().width)===288);assert.equal(await page.$eval('[data-testid="desktop-sidebar"]',e=>Math.round(e.getBoundingClientRect().width)),288);
   await page.click('[data-testid="settings-entry"]');await page.waitForSelector('[data-testid="settings-dialog"]');await fit('[data-testid="settings-dialog"]',width,height);
   assert.equal(await page.$eval('[data-testid="settings-mobile-section"]',e=>getComputedStyle(e.closest('label')).display),'none');
   assert.notEqual(await page.$eval('[data-testid="settings-nav"]',e=>getComputedStyle(e).display),'none');
   await page.screenshot({path:path.join(evidence,'settings-desktop.png')});await page.click('[data-testid="settings-close"]');
  }
  results.push({width,height,passed:true});console.log('PASS viewport',width,height);
 }
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({results,errors},null,2));
 console.log('PASS mobile drawer, settings sections, touch sizing, controls, question scroll, visual keyboard height and desktop preservation. Evidence:',evidence);
}catch(error){
 const pages=await browser.pages();const page=pages[pages.length-1];
 await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
 console.error('failure URL',page.url());
 console.error(await page.evaluate(()=>{const e=document.querySelector('[data-testid="mobile-sidebar"] > div');return e?{overflow:getComputedStyle(e).overflowY,top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight,active:document.activeElement?.outerHTML?.slice(0,200)}:null}).catch(()=>null));
 throw error;
}finally{await browser.close();fs.unlinkSync(file)}
