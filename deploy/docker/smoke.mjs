/** Run only against a disposable profile inside the candidate app container. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require = createRequire('/app/server.js');
const puppeteer = require('puppeteer-core');
const base = 'http://127.0.0.1:3000';
const get = async (route,init) => {const response=await fetch(base+route,init); assert.equal(response.status,200,route+': '+await response.clone().text()); return response.json()};
for(const route of ['/api/settings','/api/chats','/api/graph','/api/topics']) await get(route);
const catalog=await get('/api/plugins');
assert.deepEqual(catalog.plugins.filter(p=>p.origin==='core').map(p=>p.id).sort(),['coding-questions','drawing-pad','flashcards','rich-code-blocks']);
for(const id of ['coding-questions','drawing-pad','rich-code-blocks']) {
 const enabled=await get('/api/plugins/'+id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})});
 const plugin=enabled.plugins.find(p=>p.id===id);assert.equal(plugin.status,'active',JSON.stringify(plugin));
}
const capabilities=await get('/api/plugins/coding-questions/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'runner-capabilities'})});
assert.deepEqual(capabilities.result.languages.map(l=>l.id),['python','cuda','cpp','rust']);
if(process.env.LH_EXECUTION_URL)assert(capabilities.result.languages.every(l=>l.available),JSON.stringify(capabilities.result));
else assert(capabilities.result.languages.every(l=>!l.available));
for(const route of ['/api/settings','/api/plugins/coding-questions/documents/markdown']) {
 assert.equal((await fetch(base+route,{method:'POST',headers:{origin:'https://other.invalid','sec-fetch-site':'cross-site'}})).status,403);
}
assert.equal(await new Promise(resolve=>{const q=http.get(base+'/api/settings',{headers:{host:'rebind.invalid'}},r=>{r.resume();resolve(r.statusCode)});q.on('error',()=>resolve(0))}),403);
const directory=process.env.LH_DATA_DIR;
assert(directory?.startsWith('/tmp/'),'Smoke must use disposable /tmp profile');
const chat=await get('/api/chats',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Scroll validation fixture'})});
const file=path.join(directory,'chats',chat.id+'.json');
const record=JSON.parse(fs.readFileSync(file));
record.messages=[{id:'scroll-user',role:'user',content:[{type:'text',text:'Ask a question'}],timestamp:Date.now()},{id:'scroll-assistant',role:'assistant',api:'openai-responses',provider:'openai',model:'fixture',stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},content:[{type:'toolCall',id:'scroll-question',name:'ask_user_question',arguments:{question:'Which option keeps this question visible?',options:Array.from({length:15},(_,i)=>({label:'Option '+i+' '+('Long explanation to exercise independent scrolling. '.repeat(8))}))}}]}];
fs.writeFileSync(file,JSON.stringify(record));
const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--disable-dev-shm-usage']});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 for(const [width,height] of [[1280,900],[390,844],[900,600]]) {
  await page.setViewport({width,height});await page.goto(base+'/chat/'+chat.id,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('[data-testid="question-options"]',{timeout:15000});
  const before=await page.$eval('[data-testid="question-prompt"]',e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}));
  assert(before.top>=0 && before.bottom<=height,JSON.stringify({width,height,before}));
  const after=await page.$eval('[data-testid="question-options"]',e=>{e.scrollTop=e.scrollHeight;return {top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight}});
  assert(after.top>0 && after.total>after.height,JSON.stringify(after));
  const prompt=await page.$eval('[data-testid="question-prompt"]',e=>e.getBoundingClientRect().top);
  assert.equal(prompt,before.top);
  await page.hover('[data-testid="question-options"]');await page.mouse.wheel({deltaY:1000});
  assert(await page.$('[data-testid="question-options"]'),'Option scrolling collapsed the question');
  assert.equal(await page.$eval('[data-testid="question-prompt"]',e=>e.getBoundingClientRect().top),before.top);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: routes, core plugin activation, language capabilities, access refusals, sandboxed Chromium, desktop/mobile question scrolling');
} finally {await browser.close();}
