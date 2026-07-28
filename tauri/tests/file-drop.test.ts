import assert from "node:assert/strict";
import test from "node:test";
import { classifyDroppedFiles } from "../src/lib/file-drop.ts";

const DOCUMENT_KIND = 1;
const VIDEO_KIND = 2;
const AUDIO_KIND = 3;

test("homogeneous image drops are reviewed as photos across path formats", () => {
  assert.deepEqual(
    classifyDroppedFiles(["/home/me/one.PNG", String.raw`C:\Users\me\two.webp`]),
    { mode: "image", attachmentKind: DOCUMENT_KIND },
  );
});

test("homogeneous video and audio drops retain their media kinds", () => {
  assert.deepEqual(classifyDroppedFiles(["clip.mp4", "clip.MOV"]), {
    mode: "attachment",
    attachmentKind: VIDEO_KIND,
  });
  assert.deepEqual(classifyDroppedFiles(["voice.opus", "song.mp3"]), {
    mode: "attachment",
    attachmentKind: AUDIO_KIND,
  });
});

test("documents and mixed drops stay together as one document batch", () => {
  for (const paths of [["report.pdf"], ["photo.jpg", "notes.docx"], [".env"]]) {
    assert.deepEqual(classifyDroppedFiles(paths), {
      mode: "attachment",
      attachmentKind: DOCUMENT_KIND,
    });
  }
});
