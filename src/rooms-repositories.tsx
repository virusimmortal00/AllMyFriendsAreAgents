import { useEffect, useState } from "react";
import { ApiRequestError, loadRoomRepositories, type RoomRepositoryListing } from "./api";
import { useControlSession } from "./control-session";
import { ListView, type ListViewColumn } from "./list-view";
import { RepositoryName } from "./github-mark";
import { VIEWS, viewAttributes } from "./view-registry";

const REASON_LABELS: Readonly<Record<string, string>> = {
  ready: "Verified",
  "general-room": "No project",
  "connection-missing": "Not connected",
  "connection-disabled": "Disabled",
  "credential-missing": "Needs credentials",
};

export function repositoryStatusLabel(room: Pick<RoomRepositoryListing, "state" | "reason">) {
  return REASON_LABELS[room.reason] ?? (room.state === "ready" ? "Verified" : "Needs repair");
}

function shortProject(projectId: string) {
  return projectId.length > 22 ? `${projectId.slice(0, 20)}…` : projectId;
}

/** Administrator list of every room and the repository its project gives it. */
export function RoomsRepositories({ refreshKey = 0, onOpenIntegrations, onCountChange }: {
  refreshKey?: number;
  onOpenIntegrations: () => void;
  onCountChange?: (summary: string) => void;
}) {
  const { session, checked } = useControlSession(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [rooms, setRooms] = useState<readonly RoomRepositoryListing[]>();
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!session) { setRooms(undefined); return; }
    const controller = new AbortController();
    setError(""); setDenied(false);
    loadRoomRepositories(includeArchived, controller.signal).then(setRooms).catch((reason) => {
      if (controller.signal.aborted) return;
      setRooms(undefined);
      setDenied(reason instanceof ApiRequestError && [401, 403].includes(reason.status || 0));
      setError(reason instanceof Error ? reason.message : "Rooms could not be loaded.");
    });
    return () => controller.abort();
  }, [session?.principal.id, session?.principal.revision, includeArchived, refreshKey, reload]);

  useEffect(() => {
    if (!rooms) { onCountChange?.(""); return; }
    const repositories = new Set(rooms.map((room) => room.repository).filter(Boolean)).size;
    onCountChange?.(`${rooms.length} room${rooms.length === 1 ? "" : "s"} · ${repositories} repositor${repositories === 1 ? "y" : "ies"}`);
  }, [rooms, onCountChange]);

  const columns: ListViewColumn<RoomRepositoryListing>[] = [
    { key: "room", label: "Room", width: "30%", sortValue: (room) => room.name.toLocaleLowerCase(), render: (room) => <span className="rooms-repositories__room">{room.name}{room.archived ? <small> (archived)</small> : null}</span> },
    { key: "repository", label: "Repository", width: "30%", sortValue: (room) => room.repository ?? "~", render: (room) => room.repository
      ? <RepositoryName repository={room.repository} />
      : <span className="list-view__muted">(none)</span> },
    { key: "status", label: "Status", width: "20%", sortValue: (room) => repositoryStatusLabel(room), render: (room) => room.state === "ready"
      ? <span className="classic-status">Verified</span>
      : room.repository ? <button type="button" className="classic-link-button" onClick={onOpenIntegrations}><span className="classic-status" data-attention="true">{repositoryStatusLabel(room)}</span></button>
        : <span className="list-view__muted">{repositoryStatusLabel(room)}</span> },
    { key: "project", label: "Project", width: "20%", sortValue: (room) => room.projectId ?? "~", render: (room) => room.projectId ? <span title={room.projectId}>{shortProject(room.projectId)}</span> : <span className="list-view__muted">—</span> },
  ];

  return <div className="administration-page rooms-repositories" {...viewAttributes(VIEWS.roomsRepositories)}>
    <header className="page-header"><h2>Rooms &amp; repositories</h2><p>Rooms get repository access from their project. Rooms in the same project share one repository.</p></header>
    {!checked ? <p role="status">Checking server administration…</p>
      : !session ? <>
        <div className="page-toolbar">
          <label className="classic-check"><input type="checkbox" disabled checked={false} readOnly />Show archived rooms</label>
          <button type="button" className="classic-button" disabled>Refresh</button>
        </div>
        <ListView label="Rooms and repositories" columns={columns} rows={[]} rowKey={(room) => room.roomId} empty="Sign in to list rooms and their repositories." />
      </>
        : denied ? <p className="classic-summary">Your administrator account does not have permission to list rooms. Ask the server owner.</p> : <>
        <div className="page-toolbar">
          <label className="classic-check"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />Show archived rooms</label>
          <button type="button" className="classic-button" onClick={() => setReload((current) => current + 1)}>Refresh</button>
        </div>
        {error ? <p className="room-settings-error" role="alert">{error}</p> : null}
        {!rooms && !error ? <p role="status">Loading rooms…</p> : null}
        {rooms ? <ListView label="Rooms and repositories" columns={columns} rows={rooms} rowKey={(room) => room.roomId} initialSort="room" empty="No rooms." /> : null}
      </>}
  </div>;
}
