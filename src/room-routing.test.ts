// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { loadRoom, roomEventsPath, routedRoomId, scopedRequestPath, sendMessage } from "./api.js";

describe("room URL routing",()=>{
  it("derives scoped state, event, and message endpoints from /rooms/:roomId",async()=>{window.history.replaceState({},"","/rooms/room-12345678");expect(routedRoomId()).toBe("room-12345678");expect(roomEventsPath()).toBe("/api/rooms/room-12345678/events");const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async(url)=>new Response(JSON.stringify(String(url).endsWith("/messages")?{accepted:true,duplicate:false,clientMessageId:"message_12345678",messageId:"stored"}:{}),{status:200,headers:{"content-type":"application/json"}}));await loadRoom();await sendMessage("hello","message_12345678");expect(fetcher.mock.calls.map(([url])=>url)).toEqual(["/api/rooms/room-12345678/state","/api/rooms/room-12345678/messages"]);fetcher.mockRestore();});
  it("fails closed instead of falling through alternate-room operations to canonical APIs",()=>{window.history.replaceState({},"","/rooms/room-12345678");expect(scopedRequestPath("/api/tasks")).toBe("/api/rooms/room-12345678/tasks");expect(scopedRequestPath("/api/investigations/job-1/cancel")).toBe("/api/rooms/room-12345678/investigations/job-1/cancel");expect(scopedRequestPath("/api/control/me")).toBe("/api/control/me");});
  it("retains canonical compatibility outside a room route",()=>{window.history.replaceState({},"","/");expect(routedRoomId()).toBeNull();expect(roomEventsPath()).toBe("/api/events");});
});
