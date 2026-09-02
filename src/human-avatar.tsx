import { useRef, useState } from "react";
import { validHumanAvatarDataUrl } from "../shared/human-avatar";
import type { HumanPresence } from "./types";
import { DialogFrame } from "./dialog-frame";
import { AdministrationEntry } from "./server-administration";
import { VIEWS } from "./view-registry";

function initials(name: string) {
  return name.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase() || "You";
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

export async function prepareHumanAvatar(file: File) {
  if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Choose an image smaller than 8 MB.");
  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("That image could not be read.");
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Profile photo processing is unavailable in this browser.");
    const sourceSize = Math.min(decoded.width, decoded.height);
    const sourceX = (decoded.width - sourceSize) / 2;
    const sourceY = (decoded.height - sourceSize) / 2;
    context.drawImage(decoded.source, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    const avatarUrl = canvas.toDataURL("image/jpeg", .86);
    if (!validHumanAvatarDataUrl(avatarUrl)) throw new Error("The processed profile photo is too large.");
    return avatarUrl;
  } finally {
    decoded.close();
  }
}

export function HumanAvatar({ name, avatarUrl, compact = false }: { name: string; avatarUrl?: string; compact?: boolean }) {
  return (
    <span className={`human-avatar${compact ? " human-avatar--compact" : ""}`} aria-label={avatarUrl ? `${name}'s profile photo` : `${name}'s initials`}>
      <span aria-hidden="true">{initials(name)}</span>
      {avatarUrl ? <img src={avatarUrl} alt="" /> : null}
    </span>
  );
}

export function HumanProfileDialog({ human, busy, returnFocusTo, onProfileChange, onClose, onOpenAdministration }: {
  onOpenAdministration: () => void;
  human: HumanPresence;
  busy: boolean;
  returnFocusTo: HTMLElement | null;
  onProfileChange: (profile: { name: string; avatarUrl?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(human.name);
  const [avatarUrl, setAvatarUrl] = useState(human.avatarUrl);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const locked = busy || processing;
  const cleanName = name.trim().replace(/\s+/g, " ");
  const changed = cleanName !== human.name || avatarUrl !== human.avatarUrl;
  const requestClose = () => { if (!locked) onClose(); };

  async function chooseFile(file: File | undefined) {
    if (!file || locked) return;
    setProcessing(true);
    setError("");
    try {
      setAvatarUrl(await prepareHumanAvatar(file));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The profile photo could not be prepared.");
    } finally {
      setProcessing(false);
    }
  }

  async function saveProfile() {
    if (locked || !changed) return;
    setError("");
    try {
      await onProfileChange({ name: cleanName, avatarUrl });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your profile could not be saved.");
    }
  }

  return (
    <DialogFrame title="Your profile" closeLabel="Close profile settings" closeDisabled={locked} className="human-avatar-window" backdropClassName="human-avatar-backdrop" bodyClassName="human-avatar-body" returnFocusTo={returnFocusTo} onClose={requestClose} view={VIEWS.yourProfile} actionsClassName="human-profile-footer" actions={<><button type="button" className="classic-button" disabled={locked} onClick={requestClose}>Cancel</button><button type="button" className="classic-button" data-default-button disabled={locked || !changed || !cleanName} onClick={() => void saveProfile()}>{busy ? "Saving…" : "Save profile"}</button></>}>
          <HumanAvatar name={cleanName || human.name} avatarUrl={avatarUrl} />
          <label className="human-profile-name">Display name<input data-dialog-initial-focus className="classic-input" maxLength={32} value={name} aria-invalid={!cleanName} onChange={(event) => { setName(event.target.value); setError(""); }} /></label>
          <input ref={inputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { void chooseFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
          <div className="human-avatar-actions"><button type="button" className="classic-button" disabled={locked} onClick={() => inputRef.current?.click()}>{processing ? "Processing…" : avatarUrl ? "Choose another image" : "Choose image"}</button>{avatarUrl ? <button type="button" className="classic-button human-avatar-remove" disabled={locked} onClick={() => { setAvatarUrl(undefined); setError(""); }}>Remove photo</button> : null}</div>
          <small>Your name and image appear together in participant lists. Images are cropped to a square and stored as a compact room thumbnail.</small>
          <AdministrationEntry onOpen={onOpenAdministration} disabled={locked} />
          {error ? <p role="alert">{error}</p> : null}
    </DialogFrame>
  );
}
