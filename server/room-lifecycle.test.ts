import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import { RoomLifecycleStore } from "./room-lifecycle.js";
import { repositoryAuthorityBlocker } from "./storage/identity-domain.js";
import { createTask } from "../shared/task-domain.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const roots:string[]=[];
afterEach(async()=>Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true}))));
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-room-lifecycle-"));roots.push(root);const databasePath=path.join(root,"state.sqlite");const canonical=await SqliteRoomRepository.open(root,databasePath);canonical.close();const database=new DatabaseSync(databasePath,{enableForeignKeyConstraints:true});const server=database.prepare("SELECT server_id FROM durable_servers LIMIT 1").get() as {server_id:string};const projectId=randomUUID(),now=new Date().toISOString();database.prepare("INSERT INTO durable_projects(project_id,server_id,revision,name,repository_capacity,repository_reference_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(projectId,server.server_id,1,"Lifecycle fixture",0,null,now,now);database.close();const lifecycle=await RoomLifecycleStore.open(databasePath,root);return{root,databasePath,lifecycle,projectId};}

describe("durable room lifecycle",()=>{
  it("resolves membership server-side and isolates transcripts, rosters, tasks, sessions, and identities",async()=>{const value=await fixture();const a=value.lifecycle.create("human-a",{name:"Alpha"});const b=value.lifecycle.create("human-a",{name:"Beta"});expect(value.lifecycle.read(a.roomId,"human-b")).toBeUndefined();const stores=await Promise.all([a,b].map((room)=>SqliteRoomRepository.open(value.root,value.databasePath,{roomId:room.roomId})));
    expect(stores.map((store)=>store.snapshot().roster)).toEqual([{schemaVersion:3,revision:1,entries:[]},{schemaVersion:3,revision:1,entries:[]}]);
    await Promise.all(stores.map((store)=>store.updateRoster(1,[{agentId:"codex-sol",enabled:true}])));
    await Promise.all([stores[0].addMessage("you","alpha-only","chat",undefined,undefined,{id:"human-a",name:"Ada"}),stores[1].addMessage("you","beta-only","chat",undefined,undefined,{id:"human-a",name:"Ada"})]);await stores[0].setSession("codex-sol","session-alpha","read-only");await stores[1].setSession("codex-sol","session-beta","read-only");
    const task=createTask({roomId:a.roomId,taskId:"task-alpha",title:"Only alpha",actor:{id:"human-a",roomRole:"owner"},now:new Date().toISOString()});expect((await stores[0].createTask(task)).kind).toBe("created");expect(stores[0].snapshot().messages.map((message)=>message.text)).toContain("alpha-only");expect(stores[0].snapshot().messages.map((message)=>message.text)).not.toContain("beta-only");expect(stores[1].snapshot().sessions["codex-sol"]?.id).toBe("session-beta");expect((await stores[1].listTasks({roomId:b.roomId})).items).toEqual([]);stores.forEach((store)=>store.close());value.lifecycle.close();
  });
  it("keeps general rooms authority-free, audits attachment, locks detach after durable work, and preserves fork provenance",async()=>{const value=await fixture();let room=value.lifecycle.create("human-a",{name:"General"});const general=await SqliteRoomRepository.open(value.root,value.databasePath,{roomId:room.roomId});expect(await repositoryAuthorityBlocker(general,room.roomId)).toBe("room-has-no-project-authority");general.close();room=value.lifecycle.attach(room.roomId,"human-a",room.revision,value.projectId);expect(room.projectAttachment).toEqual({projectId:value.projectId,revision:1});expect(value.lifecycle.attachmentHistory(room.roomId,"human-a")).toHaveLength(1);
    const attached=await SqliteRoomRepository.open(value.root,value.databasePath,{roomId:room.roomId});const task=createTask({roomId:room.roomId,taskId:"durable",title:"Durable project work",actor:{id:"human-a",roomRole:"owner"},now:new Date().toISOString()});await attached.createTask(task);attached.close();expect(()=>value.lifecycle.attach(room.roomId,"human-a",room.revision,null)).toThrow(/locked.*fork/i);const fork=value.lifecycle.fork(room.roomId,"human-a",{});expect(fork.forkedFrom).toMatchObject({roomId:room.roomId,projectId:value.projectId,roomRevision:room.revision,attachmentRevision:1});expect(fork.projectAttachment?.projectId).toBe(value.projectId);value.lifecycle.close();
  });
  it("keeps archived rooms readable and rejects mutation",async()=>{const value=await fixture();const room=value.lifecycle.create("human-a",{name:"Archive me"});const archived=value.lifecycle.archive(room.roomId,"human-a",room.revision);expect(archived.archivedAt).toBeTruthy();expect(value.lifecycle.list("human-a",false).map(({roomId})=>roomId)).not.toContain(room.roomId);expect(value.lifecycle.list("human-a",true).map(({roomId})=>roomId)).toContain(room.roomId);expect(()=>value.lifecycle.update(room.roomId,"human-a",archived.revision,{topic:"changed"})).toThrow(/read-only/);value.lifecycle.close();});
});
