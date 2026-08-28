import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { defaultRoomAgentRoster } from "../shared/roster.js";
import { createDefaultRoomState } from "./room-store.js";
import { CANONICAL_ROOM_ID } from "./storage/room-repository.js";
import { runSqliteMigrations } from "./storage/sqlite-migrations.js";

export interface RoomLifecycleProjection {
  readonly roomId: string; readonly name: string; readonly topic: string;
  readonly revision: number; readonly archivedAt: string | null;
  readonly projectAttachment: { readonly projectId: string; readonly revision: number } | null;
  readonly forkedFrom: { readonly roomId: string; readonly projectId: string | null; readonly roomRevision: number; readonly attachmentRevision: number } | null;
  readonly createdAt: string; readonly updatedAt: string;
}

type RoomRow = { id:string; name:string; topic:string; lifecycle_revision:number; attachment_revision:number; project_id:string|null; archived_at:string|null; forked_from_room_id:string|null; forked_from_project_id:string|null; created_at:string; updated_at:string };

const clean = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().replace(/\s+/g," ").slice(0,maximum) : "";

export class RoomLifecycleStore {
  private constructor(private readonly database: DatabaseSync, private readonly projectRoot: string) {}
  static async open(databasePath: string, projectRoot: string) {
    const database = new DatabaseSync(databasePath, { timeout: 5_000, enableForeignKeyConstraints: true });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    await runSqliteMigrations(database);
    return new RoomLifecycleStore(database, projectRoot);
  }
  close() { this.database.close(); }

  ensureCanonicalMembership(humanId: string) {
    const now = new Date().toISOString();
    this.database.prepare("INSERT OR IGNORE INTO room_memberships(room_id,human_id,role,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(CANONICAL_ROOM_ID,humanId,"owner",now,now);
  }
  isMember(roomId: string, humanId: string) { return Boolean(this.database.prepare("SELECT 1 FROM room_memberships WHERE room_id=? AND human_id=?").get(roomId,humanId)); }
  list(humanId: string, includeArchived=false) {
    this.ensureCanonicalMembership(humanId);
    const rows=this.database.prepare(`SELECT r.* FROM rooms r JOIN room_memberships m ON m.room_id=r.id WHERE m.human_id=? ${includeArchived?"":"AND r.archived_at IS NULL"} ORDER BY r.updated_at DESC,r.id`).all(humanId) as RoomRow[];
    return rows.map((row)=>this.project(row));
  }
  read(roomId:string,humanId:string) { const row=this.memberRow(roomId,humanId); return row?this.project(row):undefined; }

  create(humanId:string,input:{name?:unknown;topic?:unknown;projectId?:unknown}) {
    const name=clean(input.name,80); if(!name) throw new Error("Room name is required.");
    const topic=clean(input.topic,240)||"Open conversation";
    const projectId=typeof input.projectId==="string"&&input.projectId.trim()?input.projectId.trim():null;
    if(projectId&&!this.database.prepare("SELECT 1 FROM durable_projects WHERE project_id=?").get(projectId)) throw new Error("Project attachment is unavailable.");
    const roomId=randomUUID(),now=new Date().toISOString(),server=this.database.prepare("SELECT server_id FROM durable_servers ORDER BY created_at LIMIT 1").get() as {server_id:string}|undefined;
    if(!server) throw new Error("Durable server identity is unavailable.");
    const state=createDefaultRoomState(this.projectRoot),roster=defaultRoomAgentRoster();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO rooms(id,slug,name,topic,writable_agent,conversation_energy,project_path,participant_styles_json,status,roster_revision,roster_schema_version,server_id,project_id,identity_revision,lifecycle_revision,attachment_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(roomId,`room-${roomId}`,name,topic,"nobody",state.settings.conversationEnergy,"",JSON.stringify(DEFAULT_PARTICIPANT_STYLES),"idle",roster.revision,3,server.server_id,projectId,1,1,projectId?1:0,now,now);
      roster.entries.forEach((entry,position)=>this.database.prepare("INSERT INTO room_agents(room_id,agent_id,enabled,position,configuration_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(roomId,entry.agentId,entry.enabled?1:0,position,JSON.stringify(entry),now,now));
      this.database.prepare("INSERT INTO room_memberships(room_id,human_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run(roomId,humanId,"owner",now,now);
      if(projectId)this.auditAttachment(roomId,1,humanId,null,projectId,"attach",now);
      this.database.exec("COMMIT");
    } catch(error){this.database.exec("ROLLBACK");throw error;}
    return this.read(roomId,humanId)!;
  }

  update(roomId:string,humanId:string,expectedRevision:number,input:{name?:unknown;topic?:unknown}) {
    const current=this.requireMember(roomId,humanId); this.requireRevision(current,expectedRevision);
    if(current.archived_at) throw new Error("Archived rooms are read-only.");
    const name=input.name===undefined?current.name:clean(input.name,80),topic=input.topic===undefined?current.topic:clean(input.topic,240);
    if(!name||!topic) throw new Error("Room name and topic cannot be empty.");
    const now=new Date().toISOString();
    const changed=this.database.prepare("UPDATE rooms SET name=?,topic=?,lifecycle_revision=lifecycle_revision+1,updated_at=? WHERE id=? AND lifecycle_revision=?").run(name,topic,now,roomId,expectedRevision);
    if(changed.changes!==1) throw new Error("Room revision changed."); return this.read(roomId,humanId)!;
  }
  archive(roomId:string,humanId:string,expectedRevision:number) {
    const current=this.requireMember(roomId,humanId); this.requireRevision(current,expectedRevision); if(current.archived_at)return this.project(current);
    const now=new Date().toISOString(); const changed=this.database.prepare("UPDATE rooms SET archived_at=?,status='idle',active_agent=NULL,lifecycle_revision=lifecycle_revision+1,updated_at=? WHERE id=? AND lifecycle_revision=?").run(now,now,roomId,expectedRevision);
    if(changed.changes!==1) throw new Error("Room revision changed."); return this.read(roomId,humanId)!;
  }
  attach(roomId:string,humanId:string,expectedRevision:number,projectId:string|null) {
    const current=this.requireMember(roomId,humanId); this.requireRevision(current,expectedRevision); if(current.archived_at)throw new Error("Archived rooms are read-only.");
    if(projectId&&!this.database.prepare("SELECT 1 FROM durable_projects WHERE project_id=?").get(projectId))throw new Error("Project attachment is unavailable.");
    if(current.project_id===projectId)return this.project(current);
    if(current.project_id&&this.hasProjectBackedWork(roomId))throw new Error("Project attachment is locked by durable project-backed work; fork the room to move discussion.");
    const now=new Date().toISOString(),attachmentRevision=current.attachment_revision+1,operation=current.project_id?(projectId?"rebind":"detach"):"attach";
    this.database.exec("BEGIN IMMEDIATE"); try {
      const changed=this.database.prepare("UPDATE rooms SET project_id=?,attachment_revision=?,lifecycle_revision=lifecycle_revision+1,updated_at=? WHERE id=? AND lifecycle_revision=?").run(projectId,attachmentRevision,now,roomId,expectedRevision);
      if(changed.changes!==1)throw new Error("Room revision changed."); this.auditAttachment(roomId,attachmentRevision,humanId,current.project_id,projectId,operation,now); this.database.exec("COMMIT");
    }catch(error){this.database.exec("ROLLBACK");throw error;} return this.read(roomId,humanId)!;
  }
  fork(roomId:string,humanId:string,input:{name?:unknown;topic?:unknown}) {
    const source=this.requireMember(roomId,humanId),created=this.create(humanId,{name:clean(input.name,80)||`${source.name} (fork)`,topic:input.topic===undefined?source.topic:input.topic,projectId:source.project_id});
    const now=new Date().toISOString(); this.database.exec("BEGIN IMMEDIATE"); try {
      this.database.prepare("UPDATE rooms SET forked_from_room_id=?,forked_from_project_id=? WHERE id=?").run(source.id,source.project_id,created.roomId);
      this.database.prepare("INSERT INTO room_forks(room_id,source_room_id,source_room_revision,source_project_id,source_attachment_revision,forked_by_human_id,created_at) VALUES (?,?,?,?,?,?,?)").run(created.roomId,source.id,source.lifecycle_revision,source.project_id,source.attachment_revision,humanId,now);
      this.database.prepare("INSERT INTO messages(id,room_id,speaker,text,kind,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(),created.roomId,"system",`Forked from room ${source.id} at revision ${source.lifecycle_revision}.`,"status",now);
      this.database.exec("COMMIT");
    }catch(error){this.database.exec("ROLLBACK");throw error;} return this.read(created.roomId,humanId)!;
  }
  attachmentHistory(roomId:string,humanId:string){this.requireMember(roomId,humanId);return this.database.prepare("SELECT event_id AS eventId,revision,actor_human_id AS actorHumanId,previous_project_id AS previousProjectId,project_id AS projectId,operation,occurred_at AS occurredAt FROM room_attachment_events WHERE room_id=? ORDER BY revision").all(roomId);}

  private memberRow(roomId:string,humanId:string){return this.database.prepare("SELECT r.* FROM rooms r JOIN room_memberships m ON m.room_id=r.id WHERE r.id=? AND m.human_id=?").get(roomId,humanId) as RoomRow|undefined;}
  private requireMember(roomId:string,humanId:string){const row=this.memberRow(roomId,humanId);if(!row)throw new Error("Room not found.");return row;}
  private requireRevision(row:RoomRow,expected:number){if(!Number.isSafeInteger(expected)||row.lifecycle_revision!==expected)throw new Error("Room revision changed.");}
  private hasProjectBackedWork(roomId:string){
    const probes=["SELECT 1 FROM source_work_bindings WHERE room_id=? AND project_id IS NOT NULL LIMIT 1","SELECT 1 FROM assignment_records WHERE room_id=? LIMIT 1","SELECT 1 FROM canonical_tasks WHERE room_id=? LIMIT 1","SELECT 1 FROM continuation_jobs WHERE room_id=? LIMIT 1","SELECT 1 FROM investigations WHERE room_id=? LIMIT 1"];
    return probes.some((sql)=>{try{return Boolean(this.database.prepare(sql).get(roomId));}catch{return false;}});
  }
  private auditAttachment(roomId:string,revision:number,humanId:string,previous:string|null,project:string|null,operation:string,now:string){this.database.prepare("INSERT INTO room_attachment_events(event_id,room_id,revision,actor_human_id,previous_project_id,project_id,operation,occurred_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(),roomId,revision,humanId,previous,project,operation,now);}
  private project(row:RoomRow):RoomLifecycleProjection{return {roomId:row.id,name:row.name,topic:row.topic,revision:row.lifecycle_revision,archivedAt:row.archived_at,projectAttachment:row.project_id?{projectId:row.project_id,revision:row.attachment_revision}:null,forkedFrom:row.forked_from_room_id?{roomId:row.forked_from_room_id,projectId:row.forked_from_project_id,roomRevision:(this.database.prepare("SELECT source_room_revision FROM room_forks WHERE room_id=?").get(row.id) as {source_room_revision:number}|undefined)?.source_room_revision||1,attachmentRevision:(this.database.prepare("SELECT source_attachment_revision FROM room_forks WHERE room_id=?").get(row.id) as {source_attachment_revision:number}|undefined)?.source_attachment_revision||0}:null,createdAt:row.created_at,updatedAt:row.updated_at};}
}
