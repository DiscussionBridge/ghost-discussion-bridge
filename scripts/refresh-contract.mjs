// Offline maintainer pairing, never a customer runtime download or state migration.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {managedOutput} from './managed-output.mjs';

if(process.argv.length!==3)throw Error('Usage: node scripts/refresh-contract.mjs <reviewed-contract-root>');
const root=fileURLToPath(new URL('../',import.meta.url)),source=path.resolve(process.argv[2]);
const pins={commit:'09d77c0209835c2d996aad294d161f167c7bd838',candidate:'discussionbridge-v4-core-20261029-r7',
  normative:'808042688cbde88fac0acdf1187e4cb8c251e13025bfcf09cf3a3c361ca02003',runtime:'acdfddf574910fb7e6cf2e2fe6837b3d266e8d93f1d96cee5e7699122d779076',
  schema:'e6a15a6d70f7bc8b8ee82aa22a0b9c2ff1bbf2da6277f7087118be9e026ce5c0',dependencies:'2f2a7bce6697e9ed73d2dacd29e244467e3162066d012b7801939032d0847d1e',licenses:'21fed045273e053184af7f129c5eccd3d24529b04540c2494c8eb5254d46f331'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=(name,pin)=>{const file=path.join(source,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Linked/non-file shared member');const bytes=fs.readFileSync(file);if(pin&&sha(bytes)!==pin)throw Error(`Wrong frozen shared bytes: ${name}`);return bytes;};
const candidate=JSON.parse(read('CANDIDATE.json'));if(candidate.candidate_id!==pins.candidate||candidate.implementation_version!=='0.4.0-alpha.1'||candidate.wire_version!=='v4'||candidate.release_version!==null)throw Error('Wrong shared tuple');
const normative=read('normative/CONTRACT.json',pins.normative);
const members=[['cms-runtime.mjs','src/cms-runtime.mjs',pins.runtime],['cms-schema.json','src/cms-schema.json',pins.schema],['idna/DEPENDENCIES.json','src/js-idna/DEPENDENCIES.json',pins.dependencies],['idna/LICENSES.txt','src/js-idna/LICENSES.txt',pins.licenses]].map(([target,name,pin])=>({target,bytes:read(name,pin)}));
const fixturePins={'positive-examples.json':'b3ea942e9fe6b824ab2a0af5f4eecf46b672d544856fea53929d60a359225b30','url-domain-policy.json':'e6fa88694fe1142f8754c2e50cbee752a9755d63324247aaa9db465450d5672e','url-contextj.json':'5cf9aee605cd002a75d929da35fe0f6bcb99b2dd83a78a71751dc24b95adadd8'};
const fixtures=Object.entries(fixturePins).map(([name,pin])=>({name,bytes:read('fixtures/'+name,pin)}));
const directories=new Set(['lib','lib/idna','test','test/fixtures','test/fixtures/cms-v4']);
const destinations=[...directories,'lib/PROVENANCE.json','lib/cms-vendor.mjs','discussionbridge-release.json',...members.map(m=>'lib/'+m.target),...fixtures.map(f=>'test/fixtures/cms-v4/'+f.name)];
for(const name of destinations)managedOutput(root,path.join(root,name),directories.has(name)?'directory':'file');
const vendorFile=path.join(root,'lib/cms-vendor.mjs'),oldVendor=fs.readFileSync(vendorFile,'utf8'),marker='let checked = false;';if(oldVendor.split(marker).length!==2)throw Error('Ambiguous existing vendor verifier');
const release=JSON.parse(fs.readFileSync(path.join(root,'discussionbridge-release.json'),'utf8'));
if(release.family?.version!=='0.4.0-alpha.1'||release.component?.version!=='0.4.0-alpha.1'||release.wire_version!=='v4'||release.release_version!==null)throw Error('Unexpected component release metadata');
const vendor={candidate_id:pins.candidate,wire_version:'v4',implementation_version:'0.4.0-alpha.1',release_version:null,status:candidate.status,
  runtime:{source:'src/cms-runtime.mjs',bytes:members[0].bytes.length,sha256:pins.runtime},schema:{source:'src/cms-schema.json',bytes:members[1].bytes.length,sha256:pins.schema},normative:{source:'normative/CONTRACT.json',bytes:normative.length,sha256:pins.normative}};
const frozen=value=>value!==null&&typeof value==='object'?'Object.freeze({'+Object.entries(value).map(([key,item])=>JSON.stringify(key)+':'+frozen(item)).join(',')+'})':JSON.stringify(value);
const vendorBytes=Buffer.from('import { createHash } from "node:crypto";\nimport { readFileSync } from "node:fs";\n\nexport const cmsVendor = '+frozen(vendor)+';\n\n'+oldVendor.slice(oldVendor.indexOf(marker)));
const provenance={wire_version:'v4',implementation_version:'0.4.0-alpha.1',release_version:null,candidate_id:pins.candidate,status:candidate.status,
  source:{repository:'https://github.com/DiscussionBridge/discussionbridge-adapter-contract',commit:pins.commit},normative:{path:'normative/CONTRACT.json',bytes:normative.length,sha256:pins.normative},
  members:members.map(m=>({path:m.target,bytes:m.bytes.length,sha256:sha(m.bytes)})),development_fixtures:fixtures.map(f=>({path:'test/fixtures/cms-v4/'+f.name,bytes:f.bytes.length,sha256:sha(f.bytes)})),
  limitation:'Current portable artifacts only; no native ownership, historical state rewrite, installed-profile or release authority.'};
release.candidate_id=pins.candidate;release.contract={schema_sha256:pins.schema,runtime_sha256:pins.runtime,normative_sha256:pins.normative};
// Complete source/pin/target/metadata preflight and staging precede all writes.
for(const m of members){const file=path.join(root,'lib',m.target);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,m.bytes);}
for(const f of fixtures){const file=path.join(root,'test/fixtures/cms-v4',f.name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,f.bytes);}
fs.writeFileSync(vendorFile,vendorBytes);fs.writeFileSync(path.join(root,'lib/PROVENANCE.json'),JSON.stringify(provenance,null,2)+'\n');fs.writeFileSync(path.join(root,'discussionbridge-release.json'),JSON.stringify(release,null,2)+'\n');
console.log(JSON.stringify({candidate:pins.candidate,source_commit:pins.commit,private_members:members.length,fixtures:fixtures.length,historical_state:'untouched'}));
