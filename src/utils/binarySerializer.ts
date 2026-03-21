import type { FileRecord, JobFileSummary, JobFilesResponse, JobStatus } from "../types";

// ─── Helpers ───────────────────────────────────────────────────────────

/** Convert the first 8 hex characters of a hex string into a 4-byte Buffer. */
function hexPrefixTo4Bytes(hex?: string): Buffer {
  if (!hex) return Buffer.alloc(4, 0);
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const prefix = clean.slice(0, 8).padEnd(8, "0");
  try {
    return Buffer.from(prefix, "hex");
  } catch {
    return Buffer.alloc(4, 0);
  }
}

/** Convert a 4-byte Buffer back to an 8-character lowercase hex string. */
function bytes4ToHexPrefix(buf: Buffer, offset: number): string {
  return buf.slice(offset, offset + 4).toString("hex");
}

const STATUS_TO_BYTE: Record<JobStatus, number> = {
  waiting: 0,
  active: 1,
  completed: 2,
  failed: 3,
};

const BYTE_TO_STATUS: Record<number, JobStatus> = {
  0: "waiting",
  1: "active",
  2: "completed",
  3: "failed",
};

// ─── Per-file serialization (FileRecord) ───────────────────────────────

/**
 * Binary record layout per file:
 *   1 byte  – file type char code
 *   2 bytes – name length (uint16 BE)
 *   N bytes – name (UTF-8)
 *   4 bytes – update timestamp (uint32 BE, unix seconds)
 *   4 bytes – file size (uint32 BE)
 *   4 bytes – commit prefix (first 4 bytes of hex)
 *   4 bytes – hash prefix (first 4 bytes of hex)
 */
export function serializeFiles(files: FileRecord[]): Buffer {
  const fileBuffers: Buffer[] = [];
  let totalLength = 0;

  for (const f of files) {
    // type: 1 byte
    let typeByte = 0;
    if (typeof f.file_type === "number") {
      typeByte = f.file_type & 0xff;
    } else if (typeof f.file_type === "string" && f.file_type.length > 0) {
      typeByte = f.file_type.charCodeAt(0) & 0xff;
    }

    // name UTF-8 bytes, length as uint16 BE
    const name = f.file_name ?? "";
    const nameBuf = Buffer.from(String(name), "utf8");
    const nameLen = Math.min(0xffff, nameBuf.length);
    const nameTrunc = nameBuf.slice(0, nameLen);

    // update date -> unix seconds
    let updateTs = 0;
    if (f.file_update_date) {
      const d =
        typeof f.file_update_date === "number"
          ? new Date(f.file_update_date)
          : new Date(String(f.file_update_date));
      if (!Number.isNaN(d.getTime())) {
        updateTs = Math.floor(d.getTime() / 1000);
      }
    }
    updateTs = updateTs >>> 0;

    // size -> uint32
    let size = 0;
    if (typeof f.file_size === "number") {
      size = Math.max(0, Math.floor(f.file_size));
    } else if (typeof f.file_size === "string") {
      const parsed = Number.parseInt(f.file_size, 10);
      if (Number.isFinite(parsed)) size = Math.max(0, Math.floor(parsed));
    }
    size = size >>> 0;

    const commitBuf = hexPrefixTo4Bytes(f.file_last_commit);
    const hashBuf = hexPrefixTo4Bytes(f.file_git_hash);

    const recordLen = 1 + 2 + nameTrunc.length + 4 + 4 + 4 + 4;
    const buf = Buffer.allocUnsafe(recordLen);
    let offset = 0;
    buf.writeUInt8(typeByte, offset);
    offset += 1;
    buf.writeUInt16BE(nameTrunc.length, offset);
    offset += 2;
    nameTrunc.copy(buf, offset);
    offset += nameTrunc.length;
    buf.writeUInt32BE(updateTs >>> 0, offset);
    offset += 4;
    buf.writeUInt32BE(size >>> 0, offset);
    offset += 4;
    commitBuf.copy(buf, offset, 0, 4);
    offset += 4;
    hashBuf.copy(buf, offset, 0, 4);
    offset += 4;

    fileBuffers.push(buf);
    totalLength += buf.length;
  }

  return Buffer.concat(fileBuffers, totalLength);
}

/** Shape returned when deserializing per-file binary records. */
export interface DeserializedFileRecord {
  fileType: string;
  fileName: string;
  updateTimestamp: number;
  fileSize: number;
  commitHex: string;
  hashHex: string;
}

/** Deserialize a buffer produced by {@link serializeFiles}. */
export function deserializeFiles(buf: Buffer): DeserializedFileRecord[] {
  const records: DeserializedFileRecord[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const typeByte = buf.readUInt8(offset);
    offset += 1;

    const nameLen = buf.readUInt16BE(offset);
    offset += 2;

    const fileName = buf.slice(offset, offset + nameLen).toString("utf8");
    offset += nameLen;

    const updateTimestamp = buf.readUInt32BE(offset);
    offset += 4;

    const fileSize = buf.readUInt32BE(offset);
    offset += 4;

    const commitHex = bytes4ToHexPrefix(buf, offset);
    offset += 4;

    const hashHex = bytes4ToHexPrefix(buf, offset);
    offset += 4;

    records.push({
      fileType: String.fromCharCode(typeByte),
      fileName,
      updateTimestamp,
      fileSize,
      commitHex,
      hashHex,
    });
  }

  return records;
}

// ─── JobFilesResponse serialization ────────────────────────────────────

/**
 * Serialize a complete {@link JobFilesResponse} into a single binary buffer.
 *
 * Layout:
 *   2 bytes  – jobId length (uint16 BE)
 *   N bytes  – jobId (UTF-8)
 *   2 bytes  – commit length (uint16 BE)
 *   N bytes  – commit (UTF-8)
 *   2 bytes  – commitShort length (uint16 BE)
 *   N bytes  – commitShort (UTF-8)
 *   1 byte   – status (0=waiting, 1=active, 2=completed, 3=failed)
 *   4 bytes  – progress (float32 BE)
 *   4 bytes  – file count (uint32 BE)
 *   ...      – per-file records (same layout as {@link serializeFiles})
 */
export function serializeJobFilesResponse(response: JobFilesResponse): Buffer {
  const jobIdBuf = Buffer.from(response.jobId, "utf8");
  const commitBuf = Buffer.from(response.commit, "utf8");
  const commitShortBuf = Buffer.from(response.commitShort, "utf8");

  const statusByte = STATUS_TO_BYTE[response.status] ?? 0;

  // Serialize files using the JobFileSummary fields
  const fileBuffers: Buffer[] = [];
  let filesTotalLength = 0;

  for (const f of response.files) {
    let typeByte = 0;
    if (typeof f.t === "string" && f.t.length > 0) {
      typeByte = f.t.charCodeAt(0) & 0xff;
    }

    const name = f.path ?? "";
    const nameBuf = Buffer.from(String(name), "utf8");
    const nameLen = Math.min(0xffff, nameBuf.length);
    const nameTrunc = nameBuf.slice(0, nameLen);

    let updateTs = 0;
    if (f.update) {
      const d =
        typeof f.update === "number"
          ? new Date(f.update)
          : new Date(String(f.update));
      if (!Number.isNaN(d.getTime())) {
        updateTs = Math.floor(d.getTime() / 1000);
      }
    }
    updateTs = updateTs >>> 0;

    let size = 0;
    if (typeof f.s === "number") {
      size = Math.max(0, Math.floor(f.s));
    }
    size = size >>> 0;

    const commitPrefix = hexPrefixTo4Bytes(f.commit);
    const hashPrefix = hexPrefixTo4Bytes(f.hash);

    const recordLen = 1 + 2 + nameTrunc.length + 4 + 4 + 4 + 4;
    const rec = Buffer.allocUnsafe(recordLen);
    let off = 0;
    rec.writeUInt8(typeByte, off);
    off += 1;
    rec.writeUInt16BE(nameTrunc.length, off);
    off += 2;
    nameTrunc.copy(rec, off);
    off += nameTrunc.length;
    rec.writeUInt32BE(updateTs >>> 0, off);
    off += 4;
    rec.writeUInt32BE(size >>> 0, off);
    off += 4;
    commitPrefix.copy(rec, off, 0, 4);
    off += 4;
    hashPrefix.copy(rec, off, 0, 4);
    off += 4;

    fileBuffers.push(rec);
    filesTotalLength += rec.length;
  }

  // Header size: 2+jobId + 2+commit + 2+commitShort + 1 + 4 + 4
  const headerSize =
    2 + jobIdBuf.length +
    2 + commitBuf.length +
    2 + commitShortBuf.length +
    1 + 4 + 4;

  const out = Buffer.allocUnsafe(headerSize + filesTotalLength);
  let offset = 0;

  // jobId
  out.writeUInt16BE(jobIdBuf.length, offset);
  offset += 2;
  jobIdBuf.copy(out, offset);
  offset += jobIdBuf.length;

  // commit
  out.writeUInt16BE(commitBuf.length, offset);
  offset += 2;
  commitBuf.copy(out, offset);
  offset += commitBuf.length;

  // commitShort
  out.writeUInt16BE(commitShortBuf.length, offset);
  offset += 2;
  commitShortBuf.copy(out, offset);
  offset += commitShortBuf.length;

  // status
  out.writeUInt8(statusByte, offset);
  offset += 1;

  // progress
  out.writeFloatBE(response.progress, offset);
  offset += 4;

  // file count
  out.writeUInt32BE(response.files.length, offset);
  offset += 4;

  // Copy file records
  for (const fb of fileBuffers) {
    fb.copy(out, offset);
    offset += fb.length;
  }

  return out;
}

/** Deserialize a buffer produced by {@link serializeJobFilesResponse}. */
export function deserializeJobFilesResponse(buf: Buffer): JobFilesResponse {
  let offset = 0;

  // jobId
  const jobIdLen = buf.readUInt16BE(offset);
  offset += 2;
  const jobId = buf.slice(offset, offset + jobIdLen).toString("utf8");
  offset += jobIdLen;

  // commit
  const commitLen = buf.readUInt16BE(offset);
  offset += 2;
  const commit = buf.slice(offset, offset + commitLen).toString("utf8");
  offset += commitLen;

  // commitShort
  const commitShortLen = buf.readUInt16BE(offset);
  offset += 2;
  const commitShort = buf.slice(offset, offset + commitShortLen).toString("utf8");
  offset += commitShortLen;

  // status
  const statusByte = buf.readUInt8(offset);
  offset += 1;
  const status: JobStatus = BYTE_TO_STATUS[statusByte] ?? "waiting";

  // progress
  const progress = buf.readFloatBE(offset);
  offset += 4;

  // file count
  const fileCount = buf.readUInt32BE(offset);
  offset += 4;

  // files
  const files: JobFileSummary[] = [];
  for (let i = 0; i < fileCount; i++) {
    const typeByte = buf.readUInt8(offset);
    offset += 1;

    const nameLen = buf.readUInt16BE(offset);
    offset += 2;

    const path = buf.slice(offset, offset + nameLen).toString("utf8");
    offset += nameLen;

    const updateTs = buf.readUInt32BE(offset);
    offset += 4;

    const s = buf.readUInt32BE(offset);
    offset += 4;

    const commitHex = bytes4ToHexPrefix(buf, offset);
    offset += 4;

    const hashHex = bytes4ToHexPrefix(buf, offset);
    offset += 4;

    files.push({
      t: String.fromCharCode(typeByte) as JobFileSummary["t"],
      path,
      s,
      update: new Date(updateTs * 1000).toISOString(),
      commit: commitHex,
      hash: hashHex,
    });
  }

  return { jobId, commit, commitShort, status, progress, files };
}
