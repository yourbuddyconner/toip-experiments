// Cleans a file before it leaves the source's browser (design §9). Images (JPEG, PNG, WebP) are
// decoded and drawn again on a canvas, which keeps the pixels and drops EXIF, XMP, ICC profiles,
// text chunks and embedded signatures. The result is checked, and any metadata segment left is cut.
// Other files are sent as they are, with a warning that says what they may carry.
import { findMetadata, imageKind, otherFileWarnings, stripMetadata, type Finding } from "../../../src/sanitize/metadata";

export interface CleanedFile {
  /** Shown to the source only. Never sent. */
  localName: string;
  bytes: Uint8Array;
  mediaType: string;
  cleaned: "reencoded" | "none";
  /** What was in the original. */
  before: Finding[];
  /** What is left in what will be sent: empty for a cleaned image. */
  after: Finding[];
  /** For files that couldn't be cleaned. */
  warnings: Finding[];
  previewUrl?: string;
}

const TYPES = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;

export async function cleanFile(file: File): Promise<CleanedFile> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(raw);
  if (kind === "other") {
    return { localName: file.name, bytes: raw, mediaType: file.type || "application/octet-stream", cleaned: "none", before: [], after: [], warnings: otherFileWarnings(file.name, raw) };
  }
  const mediaType = TYPES[kind];
  const before = findMetadata(raw);
  const bitmap = await createImageBitmap(new Blob([raw as BlobPart], { type: mediaType }), { imageOrientation: "from-image" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser can't clean images");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: mediaType, quality: 0.92 });
  let bytes = new Uint8Array(await blob.arrayBuffer());
  // The browser may write a different format than asked (WebP where it can't encode it).
  const outKind = imageKind(bytes);
  if (outKind === "jpeg" || outKind === "png") bytes = new Uint8Array(stripMetadata(bytes));
  const outType = outKind === "other" ? mediaType : TYPES[outKind];
  const after = findMetadata(bytes);
  return {
    localName: file.name,
    bytes,
    mediaType: outType,
    cleaned: "reencoded",
    before,
    after,
    warnings: [],
    previewUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type: outType })),
  };
}
