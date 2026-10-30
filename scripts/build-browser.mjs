import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {managedOutput} from './managed-output.mjs';
import {bundledLicense} from './bundled-license.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),output=path.join(root,'public');
const names=['discussionbridge-loader.js','discussionbridge-loader.css','discussionbridge-rich-content.js'];
const ledger=path.join(output,'browser-build-provenance.json'),noticeRoot=path.join(output,'THIRD_PARTY_LICENSES');
for(const dir of [output,noticeRoot])managedOutput(root,dir,'directory');
for(const file of [ledger,...names.map(name=>path.join(output,name))])managedOutput(root,file);
const digest=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
const previous=fs.existsSync(ledger)?JSON.parse(fs.readFileSync(ledger,'utf8')).bundledPackages:[];
if(!Array.isArray(previous)||new Set(previous.map(x=>x.file)).size!==previous.length)throw Error('Invalid previous generated notice ledger');
function previousNotice(item){
  if(!/^THIRD_PARTY_LICENSES\/[A-Za-z0-9_.-]+\.txt$/.test(item.file))throw Error('Unsafe generated notice path');
  const file=path.join(output,item.file),stat=managedOutput(root,file);if(!stat)return null;
  const actual=digest(fs.readFileSync(file));if(actual.bytes!==item.bytes||actual.sha256!==item.sha256)throw Error('Modified previous generated notice; preserve and reconcile it');return file;
}
for(const item of previous)previousNotice(item);
// Optional read-only reuse is for maintainer fixtures, not a customer install hook.
const runtimeRoot=process.env.DISCUSSIONBRIDGE_BUILD_RUNTIME_ROOT;
const require=createRequire(runtimeRoot?path.join(path.resolve(runtimeRoot),'package.json'):import.meta.url),{build}=require('esbuild');
const nodePaths=runtimeRoot?[path.join(path.resolve(runtimeRoot),'node_modules')]:[];
const common={absWorkingDir:root,nodePaths,bundle:true,format:'iife',minify:true,target:['es2022'],write:false,metafile:true,legalComments:'none'};
const loader=await build({...common,entryPoints:[path.join(root,'src/browser-loader.mjs')],outfile:'public/discussionbridge-loader.js',loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'}});
const rich=await build({...common,entryPoints:[path.join(root,'src/browser-rich-content.mjs')],outfile:'public/discussionbridge-rich-content.js'});
const files=[...loader.outputFiles,...rich.outputFiles];
if(files.length!==names.length||new Set(files.map(x=>path.resolve(x.path))).size!==names.length||files.some(x=>!names.some(name=>path.join(output,name)===path.resolve(x.path))))throw Error('Unexpected generated Ghost browser outputs');
const inputs=new Set([...Object.keys(loader.metafile.inputs),...Object.keys(rich.metafile.inputs)]),notices=new Map(),stagedNotices=new Map();
for(const input of inputs){
  let directory=path.dirname(path.resolve(root,input));
  while(directory!==path.dirname(directory)){
    const manifest=path.join(directory,'package.json');
    if(fs.existsSync(manifest)){
      const metadata=JSON.parse(fs.readFileSync(manifest,'utf8'));
      if(directory!==path.resolve(root)&&typeof metadata.name==='string'&&typeof metadata.version==='string'){
        const key=metadata.name+'@'+metadata.version;
        if(!notices.has(key)){
          const license=bundledLicense(directory,metadata),name='THIRD_PARTY_LICENSES/'+key.replace(/[^a-zA-Z0-9_.-]/g,'_')+'.txt',target=path.join(output,name),stat=managedOutput(root,target);
          if(stagedNotices.has(target))throw Error('Colliding generated license names');
          if(stat&&!previous.some(x=>x.file===name)&&!fs.readFileSync(target).equals(license.bytes))throw Error('Unowned generated notice; preserve it: '+name);
          stagedNotices.set(target,license.bytes);notices.set(key,{name:metadata.name,version:metadata.version,license:metadata.license,file:name,...digest(license.bytes),licenseSource:license.licenseSource});
        }
      }
      break;
    }
    directory=path.dirname(directory);
  }
}
const firstParty=[...inputs].map(x=>path.relative(root,path.resolve(root,x))).filter(x=>x.startsWith('src'+path.sep)&&!x.split(path.sep).includes('node_modules')).map(x=>x.split(path.sep).join('/'));
const sourceNames=[...new Set(['package.json','npm-shrinkwrap.json','scripts/build-browser.mjs','scripts/bundled-license.mjs','scripts/managed-output.mjs',...firstParty])].sort();
const inputRecords=Object.fromEntries(sourceNames.map(name=>[name,digest(fs.readFileSync(path.join(root,name)))]));
const fontRoot=path.dirname(require.resolve('katex/dist/katex.min.css'));
const fontNames=[...inputs].map(x=>path.resolve(root,x)).filter(x=>/\.(?:woff2?|ttf)$/.test(x));
const fonts=Object.fromEntries([...new Set(fontNames)].sort().map(file=>{const relative=path.relative(fontRoot,file).split(path.sep).join('/');if(!relative.startsWith('fonts/')||relative.split('/').includes('..'))throw Error('Unexpected bundled font input');return[relative,digest(fs.readFileSync(file))];}));
// Every source/license and managed destination has passed before any write.
fs.mkdirSync(noticeRoot,{recursive:true});for(const file of files)fs.writeFileSync(file.path,file.contents);for(const [file,bytes]of stagedNotices)fs.writeFileSync(file,bytes);
const current=new Set([...notices.values()].map(x=>x.file));for(const item of previous)if(!current.has(item.file)){const file=previousNotice(item);if(file)fs.unlinkSync(file);}
fs.writeFileSync(ledger,JSON.stringify({format:1,build:'npm ci && npm run build:browser',inputs:inputRecords,outputs:Object.fromEntries(files.map(file=>[path.basename(file.path),digest(file.contents)])),localFontInputs:fonts,bundledPackages:[...notices.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,item])=>item)},null,2)+'\n');
