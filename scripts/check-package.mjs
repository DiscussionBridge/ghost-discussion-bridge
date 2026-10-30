// Read-only validation of a normal installed package, before its SDK is used.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
if(process.argv.length!==3)throw Error('Usage: node scripts/check-package.mjs <package-root>');
const root=path.resolve(process.argv[2]),hash=b=>createHash('sha256').update(b).digest('hex');
const safe=name=>typeof name==='string'&&/^[A-Za-z0-9_./-]+$/.test(name)&&!name.startsWith('/')&&!name.split('/').some(x=>['','.','..'].includes(x));
function read(name){if(!safe(name))throw Error('Unsafe package member');let current=root;for(const part of name.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Linked package member');}if(!fs.lstatSync(current).isFile())throw Error('Non-file package member');return fs.readFileSync(current);}
function check(name,identity){const b=read(name);if(b.length!==identity.bytes||hash(b)!==identity.sha256)throw Error('Package byte mismatch: '+name);}
const metadata=JSON.parse(read('package.json'));if(metadata.name!=='ghost-discussion-bridge'||metadata.version!=='0.4.0-alpha.1')throw Error('Unexpected Ghost package');
const fixed={'cms-runtime.mjs':'acdfddf574910fb7e6cf2e2fe6837b3d266e8d93f1d96cee5e7699122d779076','cms-schema.json':'e6a15a6d70f7bc8b8ee82aa22a0b9c2ff1bbf2da6277f7087118be9e026ce5c0','idna/DEPENDENCIES.json':'2f2a7bce6697e9ed73d2dacd29e244467e3162066d012b7801939032d0847d1e','idna/LICENSES.txt':'21fed045273e053184af7f129c5eccd3d24529b04540c2494c8eb5254d46f331'};
for(const [name,pin]of Object.entries(fixed))if(hash(read('lib/'+name))!==pin)throw Error('Wrong frozen shared member: '+name);
const provenance=JSON.parse(read('lib/PROVENANCE.json')),release=JSON.parse(read('discussionbridge-release.json'));
if(provenance.source.commit!=='09d77c0209835c2d996aad294d161f167c7bd838'||provenance.candidate_id!=='discussionbridge-v4-core-20261029-r7'||release.candidate_id!==provenance.candidate_id||release.release_version!==null||release.contract.runtime_sha256!==fixed['cms-runtime.mjs']||release.contract.schema_sha256!==fixed['cms-schema.json']||release.contract.normative_sha256!==provenance.normative.sha256)throw Error('Wrong shared-source pairing');
if(provenance.members.length!==Object.keys(fixed).length)throw Error('Unexpected shared provenance inventory');for(const member of provenance.members)check('lib/'+member.path,member);
const browser=JSON.parse(read('public/browser-build-provenance.json')),outputs=['discussionbridge-loader.js','discussionbridge-loader.css','discussionbridge-rich-content.js'];
for(const [name,identity]of Object.entries(browser.inputs))check(name,identity);
if(JSON.stringify(Object.keys(browser.outputs).sort())!==JSON.stringify([...outputs].sort()))throw Error('Unexpected generated browser outputs');for(const name of outputs)check('public/'+name,browser.outputs[name]);
if(!Array.isArray(browser.bundledPackages)||browser.bundledPackages.length===0)throw Error('Missing browser notices');
for(const [name,version]of [['dompurify','3.4.17'],['katex','0.18.2'],['mermaid','11.17.2']]){const entries=browser.bundledPackages.filter(x=>x.name===name);if(entries.length!==1||entries[0].version!==version)throw Error('Unexpected browser dependency identity');}
const expected=new Set(['browser-build-provenance.json',...outputs]);
for(const notice of browser.bundledPackages){if(expected.has(notice.file)||!/^THIRD_PARTY_LICENSES\/[A-Za-z0-9_.-]+\.txt$/.test(notice.file))throw Error('Invalid/repeated package notice');expected.add(notice.file);check('public/'+notice.file,notice);if(!['whole-file','pinned-license-section'].includes(notice.licenseSource?.extraction)||!/^[a-f0-9]{64}$/.test(notice.licenseSource?.sha256??''))throw Error('Missing actual license source provenance');}
const fastdom=browser.bundledPackages.filter(x=>x.name==='fastdom');if(fastdom.length!==1||fastdom[0].version!=='1.0.12'||fastdom[0].sha256!=='df2ae14f12f31864acef768195afe4584b08a257f25925f49884619279f02f37'||fastdom[0].licenseSource.sha256!=='cc5669ab6f7741bb061c8a7244addc8e3af1f84ec7d2445744b59d0169a87d11')throw Error('Missing/incomplete FastDom terms');
function census(directory,prefix=''){return fs.readdirSync(directory).flatMap(name=>{const file=path.join(directory,name),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error('Linked generated member');if(stat.isDirectory())return census(file,prefix+name+'/');if(!stat.isFile())throw Error('Non-file generated member');return[prefix+name];});}
const actual=census(path.join(root,'public'));if(actual.length!==expected.size||actual.some(name=>!expected.has(name)))throw Error('Unrecorded generated browser member');
console.log(JSON.stringify({package:metadata.name,version:metadata.version,node_declared:metadata.engines.node,shared_members:Object.keys(fixed).length,browser_members:actual.length,notices:browser.bundledPackages.length,read_only:true}));
