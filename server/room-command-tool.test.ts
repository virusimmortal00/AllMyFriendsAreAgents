import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRuntime } from "./command-runtime.js";
import { RoomStore } from "./room-store.js";
import { registerRoomCommandToolRoute, RoomCommandToolBroker } from "./room-command-tool.js";

const roots:string[]=[];afterEach(async()=>Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true}))));

async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-room-command-tool-"));roots.push(root);const store=await RoomStore.open(root,path.join(root,"state"));
  const current=store.snapshot().roster!.entries.map((entry)=>entry.agentId==="codex-sol"?{...entry,commandPermissions:{allowAll:false,allowed:["help" as const,"poll" as const]}}:entry);await store.updateRoster(1,current);
  const runtime=new CommandRuntime({store,roster:()=>store.snapshot().roster!,canLaunch:()=>true,executeTask:async()=>({}),executePov:async()=>({}),deliverPov:async()=>undefined,publishStatus:async()=>undefined,deliverTask:async()=>undefined});
  const broker=new RoomCommandToolBroker(runtime);const token=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-bound",allowedCommands:["help","poll"]});return{store,runtime,broker,token};
}

describe("server-owned room_command broker",()=>{
  it("binds identity and request IDs, supports only exact transport replay, and rechecks revocation",async()=>{const api=await fixture();const input={invocation:{command:"help" as const},clientSubmissionId:"agent-tool-help-01"};const first=await api.broker.execute(api.token,input);expect(first).toMatchObject({kind:"private-help",commands:["poll","help"],duplicate:false});expect(await api.broker.execute(api.token,input)).toEqual(first);expect(await api.broker.execute(api.token,{invocation:{command:"poll",question:"Substituted",options:["A","B"]},clientSubmissionId:"agent-tool-help-01"})).toEqual({kind:"private-error",message:"That request ID is already bound to a different room command."});expect(await api.broker.execute(api.token,{invocation:{command:"poll",question:"Different",options:["A","B"]},clientSubmissionId:"agent-tool-poll-01"})).toMatchObject({kind:"accepted",duplicate:false});expect(await api.broker.execute(api.token,{invocation:{command:"polls"},clientSubmissionId:"short"})).toEqual({kind:"private-error",message:"A valid command request ID is required."});
    const next=api.store.snapshot().roster!.entries.map((entry)=>entry.agentId==="codex-sol"?{...entry,commandPermissions:{allowAll:false,allowed:["help" as const]}}:entry);await api.store.updateRoster(2,next);const revokedToken=api.broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-bound",allowedCommands:["help","poll"]});expect(await api.broker.execute(revokedToken,{invocation:{command:"poll",question:"No",options:["A","B"]},clientSubmissionId:"agent-tool-poll-02"})).toEqual({kind:"private-error",message:"That command is not available to this participant."});
  });

  it("exposes only the opaque broker route and never accepts caller-selected identity",async()=>{const api=await fixture();const app=express();app.use(express.json());registerRoomCommandToolRoute(app,api.broker);const server=app.listen(0,"127.0.0.1");await new Promise<void>((resolve)=>server.once("listening",resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;try{expect((await fetch(`${base}/api/agent-tools/room-command`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(404);const response=await fetch(`${base}/api/agent-tools/room-command`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${api.token}`},body:JSON.stringify({clientSubmissionId:"agent-route-help-01",invocation:{command:"help"},agentId:"claude-sonnet",roomId:"forged",permission:"all"})});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:"private-help",commands:["poll","help"]});const submissions=await api.store.listCommandAuditIdentities("00000000-0000-4000-8000-000000000001");expect(submissions).toEqual([expect.objectContaining({invokerKind:"agent",invokerId:"codex-sol"})]);}finally{await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
  });

  it("uses the bound agent identity for poll discovery, voting, and creator closure",async()=>{const api=await fixture();const created=await api.broker.execute(api.token,{invocation:{command:"poll",question:"Choose",options:["A","B"]},clientSubmissionId:"agent-tool-create-poll-01"}) as {poll:{pollId:string}};const pollId=created.poll.pollId;expect(await api.broker.execute(api.token,{invocation:{command:"polls"},clientSubmissionId:"agent-tool-list-polls-01"})).toMatchObject({kind:"polls",items:[{pollId,state:"OPEN"}]});expect(await api.broker.execute(api.token,{invocation:{command:"poll_vote",pollId,optionIndex:1},clientSubmissionId:"agent-tool-vote-poll-01"})).toMatchObject({kind:"accepted",poll:{ownVote:1,tallies:[0,1]}});expect(await api.broker.execute(api.token,{invocation:{command:"poll_close",pollId,expectedRevision:1},clientSubmissionId:"agent-tool-close-poll-01"})).toMatchObject({kind:"accepted",poll:{state:"CLOSED",tallies:[0,1]}});expect(await api.broker.execute(api.token,{invocation:{command:"polls"},clientSubmissionId:"agent-tool-list-polls-02"})).toMatchObject({kind:"polls",items:[]});});
});
