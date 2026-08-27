import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveAgentId } from "../shared/participants.js";
import { registerCommandRoutes } from "./command-api.js";
import { CommandRuntime } from "./command-runtime.js";
import { DeveloperTeamRegistry } from "./developer-team.js";
import { HumanPresenceRegistry } from "./human-presence.js";
import { joinHumanWithSession, HumanSessions } from "./human-session.js";
import { registerRoomCommandToolRoute, RoomCommandToolBroker } from "./room-command-tool.js";
import { RoomStore } from "./room-store.js";
import type { RoomRepository } from "./storage/room-repository.js";
import { CANONICAL_ROOM_ID } from "./storage/room-repository.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";

const roots:string[]=[];
afterEach(async()=>Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true}))));
const backends:ReadonlyArray<readonly[string,(root:string)=>Promise<{store:RoomRepository;reopen():Promise<RoomRepository>;close():void}>]>= [
  ["JSON",async(root)=>{const directory=path.join(root,"state");let store:RoomRepository=await RoomStore.open(root,directory);return{get store(){return store;},async reopen(){store=await RoomStore.open(root,directory);return store;},close(){}};}],
  ["SQLite",async(root)=>{const database=path.join(root,"room.sqlite");let store:RoomRepository=await SqliteRoomRepository.open(root,database);return{get store(){return store;},async reopen(){(store as SqliteRoomRepository).close();store=await SqliteRoomRepository.open(root,database);return store;},close(){(store as SqliteRoomRepository).close();}};}],
];

async function eventually(assertion:()=>void|Promise<void>){let failure:unknown;for(let index=0;index<1000;index++){try{await assertion();return;}catch(error){failure=error;await new Promise((resolve)=>setImmediate(resolve));}}throw failure;}

describe.each(backends)("%s real room surface",(_backend,open)=>{
  it("drives humans and agents through authenticated HTTP/tool boundaries with durable exactly-once results",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-room-surfaces-"));roots.push(root);const backend=await open(root);const store=backend.store;
    const humans=new HumanPresenceRegistry();const sessions=new HumanSessions();const providerCalls:ActiveAgentId[]=[];
    const runtime=new CommandRuntime({store,roster:()=>store.snapshot().roster!,canLaunch:()=>true,executeTask:async(agent,_prompt,hooks)=>{await hooks.active(`task-${agent}`);return{generationId:`task-${agent}`,visibleMessages:[`task-${agent}`]};},executePov:async(agent)=>{providerCalls.push(agent);return{generationId:`pov-${agent}`,visibleMessages:[`view-${agent}`]};},deliverPov:async(id,agent,messages)=>{for(const[index,message]of messages.entries())await store.addCommandDeliveryMessageOnce(id,index,agent,message,store.snapshot().settings.participantStyles[agent]);},publishStatus:async(id,text)=>{await store.addCommandAuditMessageOnce(id,text);},deliverTask:async(id,agent,messages)=>{for(const[index,message]of messages.entries())await store.addCommandDeliveryMessageOnce(id,index,agent,message,store.snapshot().settings.participantStyles[agent]);}});
    const broker=new RoomCommandToolBroker(runtime);const agentToken=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"fake-provider-session",allowedCommands:["help","task","pov","poll"]});
    const app=express();app.use(express.json());app.post("/api/humans",(request,response)=>response.status(201).json(joinHumanWithSession(request,response,humans,sessions)));registerCommandRoutes({app,runtime,store,humans,sessions,developers:new DeveloperTeamRegistry([])});registerRoomCommandToolRoute(app,broker);
    const server=app.listen(0,"127.0.0.1");await new Promise<void>((resolve)=>server.once("listening",resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const join=async(name:string)=>{const response=await fetch(`${base}/api/humans`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});expect(response.status).toBe(201);return{human:await response.json() as {id:string},cookie:(response.headers.get("set-cookie")||"").split(";")[0]!};};
    const call=(cookie:string,url:string,body?:unknown)=>fetch(`${base}${url}`,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const tool=(invocation:unknown,clientSubmissionId:string)=>fetch(`${base}/api/agent-tools/room-command`,{method:"POST",headers:{authorization:`Bearer ${agentToken}`,"content-type":"application/json"},body:JSON.stringify({invocation,clientSubmissionId,roomId:"forged-room",agentId:"claude-sonnet"})});
    try{
      const ada=await join("Ada");const grace=await join("Grace");
      const helpBody={text:"/help",clientSubmissionId:"surface-help-ada-01"};expect((await call(ada.cookie,"/api/commands",helpBody)).status).toBe(200);expect((await call(ada.cookie,"/api/commands",helpBody)).status).toBe(200);
      const privateHelp=store.snapshot().messages.filter(({recipientHumanId})=>recipientHumanId===ada.human.id);expect(privateHelp).toHaveLength(1);expect(store.snapshot().messages.some(({recipientHumanId})=>recipientHumanId===grace.human.id)).toBe(false);expect(store.snapshot().messages.some(({text})=>text==="/help")).toBe(false);
      expect((await call(ada.cookie,"/api/commands",{text:"/pov @Claude compare this",clientSubmissionId:"surface-pov-pinned-01"})).status).toBe(202);await eventually(()=>expect(providerCalls).toEqual(["claude-sonnet"]));
      const all=await call(ada.cookie,"/api/commands",{text:"/pov compare all",clientSubmissionId:"surface-pov-all-0001"});expect(all.status).toBe(202);await eventually(()=>expect(providerCalls).toEqual(["claude-sonnet","codex-sol","claude-sonnet","cursor-grok","cursor-composer","cursor-gemini-flash","cursor-glm"]));
      const createdResponse=await call(ada.cookie,"/api/commands",{text:'/poll "Choose" "A" "B"',clientSubmissionId:"surface-human-poll-01"});expect(createdResponse.status).toBe(202);const created=await createdResponse.json() as {result:{poll:{pollId:string;revision:number}}};const pollId=created.result.poll.pollId;
      expect(await (await tool({command:"polls"},"surface-agent-list-01")).json()).toMatchObject({kind:"polls",items:[{pollId,state:"OPEN"}]});
      expect((await call(grace.cookie,`/api/polls/${pollId}/votes`,{optionIndex:0,clientVoteId:"surface-grace-vote-01"})).status).toBe(201);
      expect(await (await tool({command:"poll_vote",pollId,optionIndex:1},"surface-agent-vote-01")).json()).toMatchObject({kind:"accepted",poll:{tallies:[1,1],ownVote:1}});
      expect((await call(grace.cookie,`/api/polls/${pollId}/close`,{clientCloseId:"surface-grace-close-01",expectedRevision:1})).status).toBe(403);
      const closeBody={clientCloseId:"surface-ada-close-001",expectedRevision:1};expect((await call(ada.cookie,`/api/polls/${pollId}/close`,closeBody)).status).toBe(201);expect((await call(ada.cookie,`/api/polls/${pollId}/close`,closeBody)).status).toBe(200);
      expect((await call(ada.cookie,`/api/polls/${pollId}/votes`,{optionIndex:0,clientVoteId:"surface-ada-late-vote"})).status).toBe(400);
      const projected=await (await call(ada.cookie,`/api/polls/${pollId}`)).json() as {pollId:string;state:string;tallies:number[]};expect(projected).toMatchObject({state:"CLOSED",tallies:[1,1]});expect(await (await call(ada.cookie,"/api/polls")).json()).toMatchObject({items:[]});expect(store.snapshot().messages.filter(({text})=>text.includes("Poll closed"))).toHaveLength(1);expect(await store.getCommandPoll("forged-room",pollId)).toBeUndefined();
      await runtime.close();await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));const reopened=await backend.reopen();expect(await reopened.getCommandPoll(CANONICAL_ROOM_ID,pollId)).toMatchObject({state:"CLOSED",finalTallies:[1,1],revision:2});expect(reopened.snapshot().messages.filter(({text})=>text.includes("Poll closed"))).toHaveLength(1);
    }finally{if(server.listening)await new Promise<void>((resolve)=>server.close(()=>resolve()));await runtime.close().catch(()=>undefined);backend.close();}
  });
});
