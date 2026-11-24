import { createHash } from "node:crypto";

export interface AsarIntegrity {
  algorithm: string;
  hash: string;
  blockSize?: number;
  blocks?: string[];
}

export interface AsarFileEntry {
  size: number;
  offset?: string;
  unpacked?: boolean;
  integrity?: AsarIntegrity;
  [key: string]: unknown;
}

export interface AsarDirectoryEntry {
  files: Record<string, AsarFileEntry | AsarDirectoryEntry>;
  [key: string]: unknown;
}

export interface AsarHeader {
  files: Record<string, AsarFileEntry | AsarDirectoryEntry>;
  [key: string]: unknown;
}

export interface ParsedAsar {
  header: AsarHeader;
  dataOffset: number;
  data: Buffer;
}

const PICKLE_PREFIX_SIZE = 16;
const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

function align4(value: number): number {
  return (value + 3) & ~3;
}

export function parseAsar(buffer: Buffer): ParsedAsar {
  if (buffer.length < PICKLE_PREFIX_SIZE) {
    throw new Error("ASAR archive is too small to contain a valid header.");
  }

  const picklePayloadSize = buffer.readUInt32LE(0);
  const headerSize = buffer.readUInt32LE(4);
  const stringBlockSize = buffer.readUInt32LE(8);
  const jsonSize = buffer.readUInt32LE(12);

  if (picklePayloadSize !== 4) {
    throw new Error("Unsupported ASAR pickle header layout.");
  }

  if (headerSize !== 4 + stringBlockSize) {
    throw new Error("ASAR header size fields are inconsistent.");
  }

  if (stringBlockSize < 4 || jsonSize > stringBlockSize - 4) {
    throw new Error("ASAR JSON length is outside the declared header.");
  }

  const paddedJsonSize = stringBlockSize - 4;
  if (paddedJsonSize !== align4(jsonSize)) {
    throw new Error("ASAR JSON padding is invalid.");
  }

  const jsonEnd = PICKLE_PREFIX_SIZE + jsonSize;
  if (jsonEnd > buffer.length) {
    throw new Error("ASAR header extends beyond the archive.");
  }

  let header: AsarHeader;
  try {
    header = JSON.parse(buffer.subarray(PICKLE_PREFIX_SIZE, jsonEnd).toString("utf8")) as AsarHeader;
  } catch (error) {
    throw new Error("ASAR header is not valid JSON.", { cause: error });
  }

  if (!header || typeof header.files !== "object" || header.files === null) {
    throw new Error("ASAR header has no root file table.");
  }

  const dataOffset = 8 + headerSize;
  if (dataOffset > buffer.length) {
    throw new Error("ASAR data section begins beyond the archive.");
  }

  return {
    header,
    dataOffset,
    data: buffer.subarray(dataOffset)
  };
}

export function encodeAsar(header: AsarHeader, data: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const paddedJsonSize = align4(json.length);
  const stringBlockSize = 4 + paddedJsonSize;
  const headerSize = 4 + stringBlockSize;
  const prefix = Buffer.alloc(8 + headerSize);

  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(stringBlockSize, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, PICKLE_PREFIX_SIZE);

  return Buffer.concat([prefix, data]);
}

export function getRootFile(header: AsarHeader, name: string): AsarFileEntry {
  const entry = header.files[name];
  if (!entry || "files" in entry || typeof entry.size !== "number") {
    throw new Error(`ASAR root file "${name}" was not found.`);
  }
  return entry as AsarFileEntry;
}

export function readAsarFile(archive: ParsedAsar, name: string): Buffer {
  const entry = getRootFile(archive.header, name);
  if (entry.unpacked) {
    throw new Error(`ASAR file "${name}" is unpacked and cannot be read from the archive data.`);
  }

  const offset = Number(entry.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`ASAR file "${name}" has invalid offset or size metadata.`);
  }

  const end = offset + entry.size;
  if (end > archive.data.length) {
    throw new Error(`ASAR file "${name}" points outside the archive data section.`);
  }

  const contents = archive.data.subarray(offset, end);
  const expectedHash = entry.integrity?.hash;
  if (expectedHash) {
    const actualHash = createHash("sha256").update(contents).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`ASAR integrity check failed for "${name}".`);
    }
  }

  return contents;
}

export function makeIntegrity(contents: Buffer): AsarIntegrity {
  const hash = createHash("sha256").update(contents).digest("hex");
  const blocks: string[] = [];

  for (let offset = 0; offset < contents.length; offset += INTEGRITY_BLOCK_SIZE) {
    blocks.push(
      createHash("sha256")
        .update(contents.subarray(offset, Math.min(offset + INTEGRITY_BLOCK_SIZE, contents.length)))
        .digest("hex")
    );
  }

  if (blocks.length === 0) {
    blocks.push(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  }

  return {
    algorithm: "SHA256",
    hash,
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks
  };
}
