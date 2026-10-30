import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.DISCUSSIONBRIDGE_CONTRACT_TEST_MODULE?path.resolve(process.env.DISCUSSIONBRIDGE_CONTRACT_TEST_MODULE):path.join(root,'lib');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixed={'cms-runtime.mjs':'acdfddf574910fb7e6cf2e2fe6837b3d266e8d93f1d96cee5e7699122d779076','cms-schema.json':'e6a15a6d70f7bc8b8ee82aa22a0b9c2ff1bbf2da6277f7087118be9e026ce5c0','idna/DEPENDENCIES.json':'2f2a7bce6697e9ed73d2dacd29e244467e3162066d012b7801939032d0847d1e','idna/LICENSES.txt':'21fed045273e053184af7f129c5eccd3d24529b04540c2494c8eb5254d46f331'};
for(const [name,pin]of Object.entries(fixed))assert.equal(hash(fs.readFileSync(path.join(base,name))),pin,`Wrong actual Ghost SDK member: ${name}`);
const sdk=await import(pathToFileURL(path.join(base,'cms-runtime.mjs')).href);
const packageRoot=path.dirname(base);
test('normal Ghost package declares the approved Node floor and rejects inaccurate metadata before SDK use',()=>{
  const metadata=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
  assert.equal(metadata.name,'ghost-discussion-bridge');assert.equal(metadata.engines.node,'>=22.12.0');
  const scratch=fs.mkdtempSync(path.join(tmpdir(),'ghost-minimum-guard-'));
  try{
    fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({...metadata,engines:{node:'>=22'}}));
    const result=spawnSync(process.execPath,[path.join(packageRoot,'scripts/check-package.mjs'),scratch],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stderr,/Unexpected Ghost package\/runtime minimum/);
    assert.deepEqual(fs.readdirSync(scratch),['package.json']);
  }finally{const owned=fs.realpathSync(scratch);assert.equal(path.dirname(owned),fs.realpathSync(tmpdir()));assert.ok(path.basename(owned).startsWith('ghost-minimum-guard-'));fs.rmSync(owned,{recursive:true});}
});
const fixturePins={'positive-examples.json':'b3ea942e9fe6b824ab2a0af5f4eecf46b672d544856fea53929d60a359225b30','url-domain-policy.json':'e6fa88694fe1142f8754c2e50cbee752a9755d63324247aaa9db465450d5672e','url-contextj.json':'5cf9aee605cd002a75d929da35fe0f6bcb99b2dd83a78a71751dc24b95adadd8'};
const fixtures=Object.fromEntries(Object.entries(fixturePins).map(([name,pin])=>{const bytes=fs.readFileSync(path.join(root,'test/fixtures/cms-v4',name));assert.equal(hash(bytes),pin);return[name,JSON.parse(bytes)];}));
test('actual Ghost package uses the frozen R7 SDK and independent common URL policy cases',()=>{
  assert.equal(sdk.candidateId,'discussionbridge-v4-core-20261029-r7');
  for(const item of fixtures['url-domain-policy.json'].cases){if(item.accepted){assert.equal(sdk.validateCms('Url',item.url),item.url,item.id);assert.deepEqual(sdk.cmsUrlAuthority(item.url),item.facts,item.id);}else assert.throws(()=>sdk.validateCms('Url',item.url),e=>e.code==='invalid_field',item.id);}
});
test('actual Ghost SDK preserves URL/origin bytes across every fixed Unicode and ACE ContextJ permutation',()=>{
  const template=fixtures['positive-examples.json'].fixtures.find(x=>x.type==='Connection').value,context=fixtures['url-contextj.json'].cases;assert.equal(context.length,1116);let checks=0;
  for(const item of context)for(const host of [item.label+'.example',item.asciiHost])for(const [type,value]of [['Url','https://'+host+'/Original%2F?q=%2F'],['Connection',{...template,destination_origin:'https://'+host}],['Connection',{...template,destination_origin:'https://'+host+'/'}]]){
    const before=JSON.stringify(value);if(item.accepted)assert.equal(sdk.validateCms(type,value),value,item.id);else assert.throws(()=>sdk.validateCms(type,value),e=>e.code==='invalid_field',item.id);assert.equal(JSON.stringify(value),before,item.id);checks+=2;
  }
  console.log(JSON.stringify({context_labels:context.length,checks,actual_runtime_directory:base}));
});
