import assert from "node:assert/strict";
import { test } from "node:test";
import { accountModel, parseAccountModels } from "../src/agent/chatgpt-model-metadata.ts";
const fixture = (slug = "future-model") => ({slug,display_name:"New account model",visibility:"list",supported_in_api:true,context_window:500000,input_modalities:["text","image"],supported_reasoning_levels:[{effort:"low"},{effort:"max"},{effort:"ultra"}],base_instructions:"IGNORE THIS",base_url:"https://untrusted.invalid"});
test("new account model works without static catalog and preserves reported capabilities",()=>{
 const entries=parseAccountModels([fixture()]);const model=accountModel(entries[0]!);assert.ok(model);
 assert.equal(model.id,"future-model");assert.equal(model.contextWindow,500000);assert.equal(model.maxTokens,0);
 assert.deepEqual(model.input,["text","image"]);assert.equal(model.thinkingLevelMap?.low,"low");assert.equal(model.thinkingLevelMap?.max,"max");assert.equal(model.thinkingLevelMap?.medium,null);assert.equal(model.thinkingLevelMap?.off,null);
 assert.equal(model.baseUrl,"https://api.openai.com/v1");assert.ok(!JSON.stringify(entries).includes("IGNORE THIS"));assert.ok(!JSON.stringify(entries).includes("untrusted.invalid"));
});
test("visibility/API permission, malformed IDs and duplicates are filtered",()=>{
 assert.deepEqual(parseAccountModels([{...fixture(),visibility:"hide"},{...fixture(),supported_in_api:false},{...fixture(),slug:"bad/path"},null]),[]);
 assert.equal(parseAccountModels([fixture(),fixture()]).length,1);assert.throws(()=>parseAccountModels({models:[]}));
});
test("missing or invalid metadata does not fabricate an unknown model",()=>{
 for(const v of [{context_window:0},{context_window:-1},{context_window:"500000"},{input_modalities:["audio"]},{supported_reasoning_levels:null}]){
 const entry=parseAccountModels([{...fixture(),...v}])[0]!;assert.equal(entry.metadata,undefined);assert.equal(accountModel(entry),undefined);
 }
});
test("provider none maps to off; metadata changes and model removal are reflected",()=>{
 const raw={...fixture(),supported_reasoning_levels:[{effort:"none"}]};const m=accountModel(parseAccountModels([raw])[0]!);assert.equal(m?.reasoning,false);assert.equal(m?.thinkingLevelMap?.off,"none");
 assert.equal(accountModel(parseAccountModels([{...fixture(),context_window:100000}])[0]!)?.contextWindow,100000);
 assert.deepEqual(parseAccountModels([]),[]);
});
