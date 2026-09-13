import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startService, serviceStatus, stopService } from './background-service.mjs';
const roots=[];
afterEach(async()=>{for(const root of roots.splice(0)){await stopService(root).catch(()=>{});await rm(root,{recursive:true,force:true});}});
async function fixture(fail=false){
 const root=await mkdtemp(path.join(os.tmpdir(),'amfaa-service-test-'));roots.push(root);
 const cliFile=path.join(root,'fixture.mjs');
 await writeFile(cliFile,`import {serveBackground} from ${JSON.stringify(new URL('./background-service.mjs',import.meta.url).href)};import {createServer} from 'node:http';
 await serveBackground({root:process.cwd(),start:async()=>{${fail?"throw new Error('private startup failure');":''}const server=createServer((q,r)=>r.end('fixture'));const ready=new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address())));return Object.freeze({ready,shutdown:()=>new Promise(resolve=>server.close(resolve))});}});`);
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
 it('does not claim success or leave a startup record when the server fails',async()=>{
  const input=await fixture(true);await expect(startService(input)).rejects.toThrow('could not start');
  expect(await serviceStatus(input.root)).toEqual({state:'stopped'});
 });
 it('serializes concurrent starts and recovers stale records without signalling a PID',async()=>{
  const input=await fixture();
  await writeFile(path.join(input.root,'.amfaa-service.json'),JSON.stringify({version:1,token:'a'.repeat(64),port:0,created:Date.now()-100000,pid:process.pid}),{mode:0o600});
  expect(await stopService(input.root)).toEqual({state:'stopped'});
  const results=await Promise.allSettled([startService(input),startService(input)]);
  expect(results.some(x=>x.status==='fulfilled')).toBe(true);
  const records=results.filter(x=>x.status==='fulfilled').map(x=>x.value.url);
  expect(new Set(records).size).toBe(1);
  expect((await serviceStatus(input.root)).state).toBe('running');
 });
});
