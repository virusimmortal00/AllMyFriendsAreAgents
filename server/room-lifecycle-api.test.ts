import { afterEach, describe, expect, it } from "vitest";
import type express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import { RoomLifecycleStore } from "./room-lifecycle.js";
import { RoomRuntimeRegistry } from "./room-runtime-registry.js";
import { registerRoomLifecycleRoutes } from "./room-lifecycle-api.js";
import { HumanPresenceRegistry } from "./human-presence.js";
import { HUMAN_SESSION_COOKIE, HumanSessions } from "./human-session.js";

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!();});
type Handler=(request:express.Request,response:express.Response)=>unknown;

async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-room-api-"));const databasePath=path.join(root,"state.sqlite");const canonical=await SqliteRoomRepository.open(root,databasePath);canonical.close();const lifecycle=await RoomLifecycleStore.open(databasePath,root);const humans=new HumanPresenceRegistry(),sessions=new HumanSessions();const ada=humans.join({name:"Ada"}),grace=humans.join({name:"Grace"});const runtimes=new RoomRuntimeRegistry((roomId)=>SqliteRoomRepository.open(root,databasePath,{roomId}),{perRoomLimit:2,globalLimit:4,providerLimits:{},dormantAfterMs:100});const handlers=new Map<string,Handler>();const app={} as express.Express;for(const method of ["get","post","patch","put"] as const)(app[method] as unknown)=(route:string,handler:Handler)=>{handlers.set(`${method}:${route}`,handler);return app;};registerRoomLifecycleRoutes({app,lifecycle,runtimes,humans,sessions});
  const call=async(method:"get"|"post"|"patch"|"put",route:string,id:string,input:{params?:Record<string,string>;body?:unknown;query?:Record<string,string>}={})=>{let status=200,payload:unknown;const request={...input,params:input.params||{},body:input.body||{},query:input.query||{},header:(name:string)=>name.toLowerCase()==="cookie"?`${HUMAN_SESSION_COOKIE}=${sessions.issue(id)}`:undefined} as unknown as express.Request;const response={status:(value:number)=>{status=value;return response;},set:()=>response,json:(value:unknown)=>{payload=value;return response;}} as unknown as express.Response;await handlers.get(`${method}:${route}`)!(request,response);return{status,payload};};cleanup.push(async()=>{runtimes.close();lifecycle.close();await rm(root,{recursive:true,force:true});});return{call,ada,grace};}

describe("room lifecycle API authorization",()=>{
  it("never accepts caller-selected participant authority and resolves every room through session membership",async()=>{const value=await fixture();const collection="/api/rooms";const item="/api/rooms/:roomId",messages="/api/rooms/:roomId/messages",state="/api/rooms/:roomId/state";const attack=await value.call("post",collection,value.ada.id,{body:{name:"Stolen",actorId:value.grace.id}});expect(attack.status).toBe(400);const createdResponse=await value.call("post",collection,value.ada.id,{body:{name:"Private room"}});expect(createdResponse.status).toBe(201);const created=createdResponse.payload as {roomId:string};expect((await value.call("get",item,value.grace.id,{params:{roomId:created.roomId}})).status).toBe(404);expect((await value.call("post",messages,value.grace.id,{params:{roomId:created.roomId},body:{text:"intrusion",clientMessageId:"message_intrusion"}})).status).toBe(404);const sent=await value.call("post",messages,value.ada.id,{params:{roomId:created.roomId},body:{text:"member message",clientMessageId:"message_member_01"}});expect(sent.status).toBe(201);const snapshot=await value.call("get",state,value.ada.id,{params:{roomId:created.roomId}});expect((snapshot.payload as {messages:Array<{text:string}>}).messages.map(({text})=>text)).toContain("member message");});
});
