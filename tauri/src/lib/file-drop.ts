import type { AttachmentKind } from "./types";
import type { FileSendMode } from "../state/app";

export interface DroppedFileBatch {
  mode: FileSendMode;
  attachmentKind: AttachmentKind;
}

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mkv", "mov", "mp4", "webm"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"]);
const DOCUMENT_KIND = 1 satisfies AttachmentKind;
const VIDEO_KIND = 2 satisfies AttachmentKind;
const AUDIO_KIND = 3 satisfies AttachmentKind;

function extension(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const separator = name.lastIndexOf(".");
  return separator > 0 ? name.slice(separator + 1).toLocaleLowerCase() : "";
}

/**
 * Keep one WhatsApp send mode per confirmed batch. Homogeneous media drops
 * retain their native photo/video/audio treatment; mixed drops remain a
 * single reviewable batch and are sent as documents without guessing.
 */
export function classifyDroppedFiles(paths: string[]): DroppedFileBatch {
  const extensions = paths.map(extension);
  if (extensions.length > 0 && extensions.every((value) => IMAGE_EXTENSIONS.has(value))) {
    return { mode: "image", attachmentKind: DOCUMENT_KIND };
  }
  if (extensions.length > 0 && extensions.every((value) => VIDEO_EXTENSIONS.has(value))) {
    return { mode: "attachment", attachmentKind: VIDEO_KIND };
  }
  if (extensions.length > 0 && extensions.every((value) => AUDIO_EXTENSIONS.has(value))) {
    return { mode: "attachment", attachmentKind: AUDIO_KIND };
  }
  return { mode: "attachment", attachmentKind: DOCUMENT_KIND };
}
