export const MAX_HUMAN_AVATAR_BYTES = 64 * 1024;

const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/;

function hasExpectedSignature(bytes: Uint8Array, mime: string) {
  if (mime === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export function validHumanAvatarDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_HUMAN_AVATAR_BYTES * 1.4 + 64) return false;
  const match = value.match(AVATAR_DATA_URL);
  if (!match) return false;
  try {
    const binary = typeof Buffer === "undefined" ? atob(match[2]) : Buffer.from(match[2], "base64").toString("binary");
    if (!binary.length || binary.length > MAX_HUMAN_AVATAR_BYTES) return false;
    const bytes = Uint8Array.from(binary.slice(0, 12), (character) => character.charCodeAt(0));
    return hasExpectedSignature(bytes, match[1]);
  } catch {
    return false;
  }
}
