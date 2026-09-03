// Provider-free acceptance. Every writable Docker object is created by this run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const mode=process.argv[2];
const image=process.argv[3];
const platform=process.argv[4]||'linux/arm64';
const root=path.resolve(import.meta.dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'amfaa-image-check-'));
const markerFile=path.join(root,'.container-isolation-sentinel');
const docker=(args,input)=>execFileSync('docker',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:180_000,maxBuffer:16*1024*1024});
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
let container;
const volumes=[];
const mounts=['/data','/worktrees','/home/node/.allmyfriendsareagents','/home/node/.cache','/home/node/.config/opencode','/home/node/.local/share/opencode'];
const volumeArgs=()=>mounts.flatMap((target,index)=>['--mount',`type=volume,src=${volumes[index]},dst=${target}`]);
const node=(code,running=true)=>docker(running?['exec','-i',container,'node','-']:['run','--rm','--init','--network','none','--platform',platform,...volumeArgs(),'--entrypoint','node','-i',image,'-'],code);
async function ready(){
  for(let attempt=0;attempt<120;attempt++) {
    try {docker(['exec',container,'node','-e',"fetch('http://127.0.0.1:53147/api/ready',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);return;}catch{}
    await delay(250);
  }
  throw new Error('Isolated image did not become ready.');
}
function start(){docker(['run','--detach','--init','--network','none','--platform',platform,'--name',container,...volumeArgs(),'-e','ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND=sqlite','-e','ALL_MY_FRIENDS_ARE_AGENTS_SQLITE_PATH=/data/amfaa.sqlite','-e','ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR=/data','-e','ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR=/worktrees','-e','ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH=/workspace',image]);}
const freshProbe=`
import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {createHash,createDecipheriv} from 'node:crypto';
const db=new DatabaseSync('/data/amfaa.sqlite',{readOnly:true});
const count=sql=>db.prepare(sql).get().n;
let credentialRecords=0;
if(fs.existsSync('/data/github-credentials.enc')) {
  const directory=createHash('sha256').update('/app').digest('hex').slice(0,24);
  const raw=fs.readFileSync('/home/node/.allmyfriendsareagents/keys/'+directory+'/github-credentials.key','utf8');
  const prefix='amfaa-github-vault-key-v1:';if(!raw.startsWith(prefix))throw new Error('Invalid fixture vault key format');
  const key=Buffer.from(raw.slice(prefix.length).trim(),'base64');
  const envelope=JSON.parse(fs.readFileSync('/data/github-credentials.enc','utf8'));
  const keyId=createHash('sha256').update(key).digest('hex');if(keyId!==envelope.keyId)throw new Error('Invalid fixture vault pairing');
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAAD(Buffer.from('amfaa:github-credential-vault:v1:'+keyId));decipher.setAuthTag(Buffer.from(envelope.authenticationTag,'base64'));
  const vault=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
  credentialRecords=vault.credentials.filter(record=>record.credential!==null).length;
}
console.log(JSON.stringify({
  roster:count('SELECT count(*) n FROM room_agents'),
  importedMessages:count("SELECT count(*) n FROM messages WHERE speaker != 'system'"),
  providerAuth:fs.existsSync('/home/node/.local/share/opencode/auth.json'),
  credentialRecords,
  ownerConfigured:fs.existsSync('/data/control-plane.json')&&Boolean(JSON.parse(fs.readFileSync('/data/control-plane.json','utf8')).ownerId),
  repositoryChoices:fs.existsSync('/data/project-repository-connections.json')&&JSON.parse(fs.readFileSync('/data/project-repository-connections.json','utf8')).connections.length>0
}));db.close();`;

try {
  if(mode==='context') {
    const marker=`AMFAA_FICTIONAL_PRIVATE_SENTINEL_${randomUUID()}`;
    fs.writeFileSync(markerFile,marker,{flag:'wx'});
    for(const name of ['.env','.env.container','.runtime/private.json','.allmyfriendsareagents/auth.json','scratch-private.txt','server/.env.local','server/.runtime/private.json','config/auth.json']) {
      const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,marker,{flag:'wx'});
    }
    docker(['build','--file','-','--output',`type=local,dest=${temporary}`,root],'FROM scratch\nCOPY . /\n');
    const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())scan(file);else if(entry.isFile())assert(!fs.readFileSync(file).includes(marker),'Private sentinel entered build context.');}};
    scan(temporary);console.log('Build-context isolation passed.');
  } else if(mode==='layers') {
    assert(image,'An image is required.');
    const marker=Buffer.from(fs.readFileSync(markerFile,'utf8'));
    const archive=path.join(temporary,'image.tar');docker(['image','save','--output',archive,image]);
    const manifest=JSON.parse(execFileSync('tar',['-xOf',archive,'manifest.json'],{encoding:'utf8'}));
    const layers=[...new Set(manifest.flatMap(entry=>entry.Layers))];
    for(const layer of layers) {
      assert(!layer.startsWith('-')&&!layer.includes('..'),'Unexpected layer path.');
      const child=spawn('tar',['-xOf',archive,layer],{stdio:['ignore','pipe','pipe']});
      let tail=Buffer.alloc(0),found=false;
      for await(const chunk of child.stdout){const bytes=Buffer.concat([tail,chunk]);if(bytes.includes(marker))found=true;tail=bytes.subarray(Math.max(0,bytes.length-marker.length));}
      const status=await new Promise(resolve=>{if(child.exitCode!==null)resolve(child.exitCode);else child.once('exit',resolve);});
      assert(status===0,'Layer extraction failed.');assert(!found,'Private sentinel found in an image layer.');
    }
    console.log(`Image layer isolation passed (${layers.length} layers).`);
  } else if(mode==='runtime') {
    assert(image&&/^linux\/(amd64|arm64)$/.test(platform),'Image and supported platform required.');
    const id=randomUUID();container=`amfaa-image-check-${id}`;
    for(let i=0;i<mounts.length;i++){const name=`${container}-${i}`;docker(['volume','create','--label','io.amfaa.fixture=true',name]);volumes.push(name);}
    const info=JSON.parse(docker(['image','inspect','--platform',platform,image]))[0];
    assert(info.Config.Labels['org.opencontainers.image.revision']===process.env.EXPECTED_APP_REVISION,'Wrong application image revision.');
    assert(info.Config.Labels['io.allmyfriendsareagents.opencode.revision']==='6883ca5bd35a5494fb2759018373308911c79e01','Wrong downstream image revision.');
    assert(docker(['run','--rm','--network','none','--platform',platform,'--entrypoint','opencode',image,'--version']).trim()==='1.18.25-amfaa.2','Wrong OpenCode version.');
    start();await ready();const fresh=JSON.parse(node(freshProbe));
    const health=JSON.parse(node(fs.readFileSync(path.join(root,'scripts/container-opencode-health.mjs'))));
    assert(health.authenticatedHealth===200&&health.unauthenticatedHealth===401,'OpenCode authenticated health failed.');
    docker(['restart',container]);await ready();const restarted=JSON.parse(node(freshProbe));
    docker(['stop',container]);
    node(`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync('/data/amfaa.sqlite');const room=db.prepare('SELECT id FROM rooms LIMIT 1').get().id;
      db.prepare('UPDATE rooms SET name=?, topic=? WHERE id=?').run('Fixture room','Preserved fixture topic',room);
      db.prepare('DELETE FROM room_agents WHERE room_id=?').run(room);
      db.prepare('INSERT INTO messages(id,room_id,speaker,speaker_name,human_id,text,created_at) VALUES(?,?,?,?,?,?,?)').run('fixture-history',room,'human','Fixture','fixture-human','Fictional history marker',new Date().toISOString());db.close();
      fs.writeFileSync('/data/fixture-envelope.enc','fictional-envelope');fs.writeFileSync('/home/node/.allmyfriendsareagents/fixture.key','fictional-paired-key');
      fs.writeFileSync('/home/node/.local/share/opencode/auth.json',JSON.stringify({'fixture-provider':{type:'api',key:'fictional-not-a-real-credential'}}));`,false);
    docker(['rm',container]);start();await ready();
    const preserved=JSON.parse(node(`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/amfaa.sqlite',{readOnly:true});
      console.log(JSON.stringify({history:db.prepare("SELECT text FROM messages WHERE id='fixture-history'").get()?.text==='Fictional history marker',settings:db.prepare("SELECT count(*) n FROM rooms WHERE name='Fixture room' AND topic='Preserved fixture topic'").get().n===1,emptyRoster:db.prepare('SELECT count(*) n FROM room_agents').get().n===0,envelope:fs.readFileSync('/data/fixture-envelope.enc','utf8')==='fictional-envelope',key:fs.readFileSync('/home/node/.allmyfriendsareagents/fixture.key','utf8')==='fictional-paired-key',auth:JSON.parse(fs.readFileSync('/home/node/.local/share/opencode/auth.json','utf8'))['fixture-provider']?.key==='fictional-not-a-real-credential'}));db.close();`));
    assert(Object.values(preserved).every(Boolean),'Existing fixture state changed during replacement.');
    console.log(JSON.stringify({platform,health,fresh,restarted,preserved}));
    assert(!fresh.importedMessages&&!fresh.providerAuth&&!fresh.credentialRecords&&!fresh.ownerConfigured&&!fresh.repositoryChoices,'Fresh image inherited user configuration.');
    assert(JSON.stringify(fresh)===JSON.stringify(restarted),'Fresh restart changed configuration.');
    assert(fresh.roster===0,'Fresh roster is not empty: public release remains blocked by issue #162.');
    console.log('Fresh/reused-volume acceptance passed.');
  } else throw new Error('Expected context, layers, or runtime mode.');
} catch(error) {
  // Only emit our bounded assertions, never subprocess stdout/stderr.
  console.error(error.status!==undefined?'Image acceptance subprocess failed; logs suppressed.':error.message);
  process.exitCode=1;
} finally {
  let cleanupFailed=false;
  if(container){try{docker(['rm','--force',container]);}catch{cleanupFailed=true;}}
  for(const volume of volumes){try{docker(['volume','rm',volume]);}catch{cleanupFailed=true;}}
  if(cleanupFailed){console.error('Fixture cleanup incomplete; inspect only objects named amfaa-image-check- with this run UUID.');process.exitCode=1;}
  fs.rmSync(temporary,{recursive:true,force:true});
}
