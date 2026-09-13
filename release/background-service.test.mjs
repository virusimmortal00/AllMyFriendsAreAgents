import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withLifecycleLock } from './lifecycle-lock.mjs';
import path from 'node:path';
import { startService, serviceStatus, stopService } from './background-service.mjs';
const roots=[];
afterEach(async()=>{for(const root of roots.splice(0)){await stopService(root).catch(()=>{});await rm(root,{recursive:true,force:true});}});
async function fixture(fail=false,holdShutdown=false){
 const root=await mkdtemp(path.join(os.tmpdir(),'amfaa-service-test-'));roots.push(root);
 const cliFile=path.join(root,'fixture.mjs');
 await writeFile(cliFile,`import {serveBackground} from ${JSON.stringify(new URL('./background-service.mjs',import.meta.url).href)};import {createServer} from 'node:http';import {access} from 'node:fs/promises';
 await serveBackground({root:process.cwd(),start:async()=>{${fail?"throw new Error('private startup failure');":''}const server=createServer((q,r)=>r.end('fixture'));const ready=new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address())));return Object.freeze({ready,shutdown:async()=>{${holdShutdown?"while(!await access('.allow-stop').then(()=>true,()=>false))await new Promise(resolve=>setTimeout(resolve,25));":''}await new Promise(resolve=>server.close(resolve));}});}});`);
 return {root,cliFile,project:root};
}
describe('native background lifecycle',()=>{
 it('starts, reports readiness, rejects duplicate starts, stops and restarts',async()=>{
  const input=await fixture();expect(await serviceStatus(input.root)).toEqual({state:'stopped'});
  const started=await startService(input);expect(started.state).toBe('running');
  expect(await (await fetch(started.url)).text()).toBe('fixture');
  expect(await startService(input)).toEqual(started);
  const metadata=path.join(input.root,'.amfaa-service.json');
  if(process.platform!=='win32')expect((await stat(metadata)).mode&0o777).toBe(0o600);
  const control=JSON.parse(await readFile(metadata,'utf8'));
  expect((await fetch(`http://127.0.0.1:${control.port}/stop`,{method:'POST'})).status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${control.port}/stop`,{method:'GET',headers:{Authorization:`Bearer ${control.token}`}})).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${control.port}/stop`,{method:'POST',headers:{Authorization:`Bearer ${control.token}`,Origin:'http://example.test'}})).status).toBe(403);
  expect((await serviceStatus(input.root)).state).toBe('running');
  expect(await stopService(input.root)).toEqual({state:'stopped'});
  expect(await serviceStatus(input.root)).toEqual({state:'stopped'});
  expect((await startService(input)).state).toBe('running');
 });
 it('rejects startup while the existing service is draining',async()=>{
  const input=await fixture(false,true);await startService(input);
  const metadata=path.join(input.root,'.amfaa-service.json');
  const before=await readFile(metadata,'utf8');
  const stopping=stopService(input.root);
  try {
   await expect.poll(async()=>(await serviceStatus(input.root)).state).toBe('stopping');
   await expect(startService(input)).rejects.toThrow('AMFAA is stopping');
   expect(await readFile(metadata,'utf8')).toBe(before);
  } finally {
   await writeFile(path.join(input.root,'.allow-stop'),'');
   await stopping;
  }
  expect(await serviceStatus(input.root)).toEqual({state:'stopped'});
 });
 it('does not claim success or leave a startup record when the server fails',async()=>{
  const input=await fixture(true);await expect(startService(input)).rejects.toThrow('could not start');
  expect(await serviceStatus(input.root)).toEqual({state:'stopped'});
 });
 it('preserves an old live service record when control becomes unreachable',async()=>{
  const input=await fixture();await startService(input);
  const metadata=path.join(input.root,'.amfaa-service.json');
  const original=await readFile(metadata,'utf8');
  const unreachable=JSON.stringify({...JSON.parse(original),port:1,created:Date.now()-100000});
  try {
   await writeFile(metadata,unreachable,{mode:0o600});
   expect(await serviceStatus(input.root)).toEqual({state:'unknown'});
   await expect(startService(input)).rejects.toThrow('preserved');
   await expect(stopService(input.root)).rejects.toThrow('preserved');
   expect(await readFile(metadata,'utf8')).toBe(unreachable);
  } finally {await writeFile(metadata,original,{mode:0o600});}
  expect((await serviceStatus(input.root)).state).toBe('running');
 });
 it('waits for a lifecycle mutation before checking and starting',async()=>{
  const input=await fixture();let release;let entered;
  const held=new Promise(resolve=>{entered=resolve;});
  const mutation=withLifecycleLock(input.root,async()=>{entered();await new Promise(resolve=>{release=resolve;});});
  await held;let started=false;
  const pending=startService(input).then(result=>{started=true;return result;});
  try {
   await new Promise(resolve=>setTimeout(resolve,150));
   expect(started).toBe(false);
   expect(await serviceStatus(input.root)).toEqual({state:'stopped'});
  } finally {release();await mutation;}
  expect((await pending).state).toBe('running');
 });
 it('serializes concurrent starts and recovers stale records without signalling a PID',async()=>{
  const input=await fixture();
  const exited=spawn(process.execPath,['-e',''],{stdio:'ignore'});
  await once(exited,'exit');
  await writeFile(path.join(input.root,'.amfaa-service.json'),JSON.stringify({version:1,token:'a'.repeat(64),port:0,created:Date.now()-100000,pid:exited.pid}),{mode:0o600});
  expect(await stopService(input.root)).toEqual({state:'stopped'});
  const results=await Promise.allSettled([startService(input),startService(input)]);
  expect(results.some(x=>x.status==='fulfilled')).toBe(true);
  const records=results.filter(x=>x.status==='fulfilled').map(x=>x.value.url);
  expect(new Set(records).size).toBe(1);
  expect((await serviceStatus(input.root)).state).toBe('running');
 });
});
