import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {chromium} from 'playwright-core';

const loader=fs.readFileSync(new URL('../public/discussionbridge-loader.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/discussionbridge-loader.css',import.meta.url),'utf8');
const rich=fs.readFileSync(new URL('../public/discussionbridge-rich-content.js',import.meta.url),'utf8');
async function browser(){const executablePath=process.env.DISCUSSIONBRIDGE_BROWSER_EXECUTABLE;return chromium.launch({headless:true,...(executablePath?{executablePath}:{channel:'chrome'})});}
async function content(page,math){
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><article class="gh-content"></article></body></html>');
  await page.evaluate(withMath=>{
    window.__bridgeXss=0;
    for(const source of ['flowchart LR\n A[Source] --> B[Destination]','flowchart TD\n A["<img src=x onerror=window.__bridgeXss=1>"] --> B[Safe]','flowchart LR\n A[Third] --> B[Done]']){
      const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-mermaid';code.textContent=source;pre.append(code);document.querySelector('article').append(pre);
    }
    if(withMath)for(const source of ['\\int_0^1 x^2\\,dx=\\frac{1}{3}','\\href{javascript:window.__bridgeXss=1}{unsafe}','\\notARealMathCommand{']){const div=document.createElement('div');div.className='math';div.textContent=source;document.querySelector('article').append(div);}
  },math);
}
test('actual Ghost loader renders strict diagrams, local math and failed source without outside traffic',async()=>{
  const b=await browser();try{
    const context=await b.newContext({serviceWorkers:'block'}),requests=[],outside=[];
    await context.route('**/*',route=>{const url=route.request().url();requests.push(url);if(url==='https://adapter.example/discussionbridge/assets/loader.js')return route.fulfill({status:200,contentType:'application/javascript',body:loader});if(url==='https://adapter.example/discussionbridge/assets/loader.css')return route.fulfill({status:200,contentType:'text/css',body:css});outside.push(url);return route.abort();});
    const page=await context.newPage();await content(page,true);await page.addScriptTag({url:'https://adapter.example/discussionbridge/assets/loader.js'});
    await page.waitForFunction(()=>document.querySelectorAll('.discussionbridge-mermaid svg').length===3&&document.querySelectorAll('article .katex-mathml').length>=2&&document.querySelector('link[data-discussionbridge-renderer-style]')?.sheet,undefined,{timeout:20000});
    const result=await page.evaluate(()=>({diagrams:document.querySelectorAll('.discussionbridge-mermaid svg').length,mathml:document.querySelectorAll('article .katex-mathml').length,xss:window.__bridgeXss,active:document.querySelectorAll('article script,article [onerror],article [onclick],article a[href^="javascript:"]').length,failedSource:[...document.querySelectorAll('article .katex-error')].some(x=>x.textContent==='\\notARealMathCommand{')}));
    assert.equal(result.diagrams,3);assert.ok(result.mathml>=2);assert.equal(result.xss,0);assert.equal(result.active,0);assert.equal(result.failedSource,true);assert.match(css,/data:(?:font\/|application\/)/);assert.deepEqual(outside,[]);assert.equal(requests.length,2);
    console.log(JSON.stringify({...result,syntheticAssetRequests:requests.length,outsideRequests:outside.length}));
  }finally{await b.close();}
});
test('actual Ghost native rich-content bundle renders strict diagrams with all page network blocked',async()=>{
  const b=await browser();try{
    const context=await b.newContext({serviceWorkers:'block'}),requests=[];await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
    const page=await context.newPage();await content(page,false);await page.addScriptTag({content:rich});await page.waitForFunction(()=>document.querySelectorAll('.discussionbridge-mermaid svg').length===3,undefined,{timeout:20000});
    const result=await page.evaluate(()=>({diagrams:document.querySelectorAll('.discussionbridge-mermaid svg').length,xss:window.__bridgeXss,active:document.querySelectorAll('article script,article [onerror],article [onclick],article a[href^="javascript:"]').length}));
    assert.equal(result.diagrams,3);assert.equal(result.xss,0);assert.equal(result.active,0);assert.deepEqual(requests,[]);console.log(JSON.stringify({...result,networkRequests:requests.length}));
  }finally{await b.close();}
});
