/**
 * Private, host-owned library for user-supplied startup audio.
 * Only MP3 and Ogg Vorbis/Opus are accepted; files are stored under generated
 * names and never loaded from caller-controlled paths.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DOCUMENT_VERSION = 1 as const;
const AUDIO_ID = /^[a-f0-9]{32}$/;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_DURATION_SECONDS = 3;
interface AudioRecord { readonly id: string; readonly name: string; readonly format: "mp3" | "ogg"; readonly duration: number; }
interface AudioDocument { readonly version: typeof DOCUMENT_VERSION; readonly activeAudioId: string | null; readonly files: readonly AudioRecord[]; }
export interface ImportedAudio { readonly id: string; readonly name: string; readonly format: "mp3" | "ogg"; readonly duration: number; readonly active: boolean; }
export interface ActiveAudio extends ImportedAudio { readonly bytes: Uint8Array; readonly mimeType: "audio/mpeg" | "audio/ogg"; }
export interface AudioStoreOptions { readonly directory: string; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parseDocument(input: unknown): AudioDocument {
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "activeAudioId,files,version" ||
      input.version !== DOCUMENT_VERSION || !Array.isArray(input.files) ||
      (input.activeAudioId !== null && (typeof input.activeAudioId !== "string" || !AUDIO_ID.test(input.activeAudioId)))) {
    throw new Error("Invalid startup audio library document.");
  }
  const ids = new Set<string>();
  const files: AudioRecord[] = [];
  for (const item of input.files) {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "duration,format,id,name" ||
        typeof item.id !== "string" || !AUDIO_ID.test(item.id) ||
        typeof item.name !== "string" || item.name.length < 1 || item.name.length > 120 ||
        (item.format !== "mp3" && item.format !== "ogg") ||
        typeof item.duration !== "number" || !Number.isFinite(item.duration) ||
        item.duration <= 0 || item.duration > MAX_DURATION_SECONDS) throw new Error("Invalid startup audio record.");
    if (ids.has(item.id)) throw new Error("Duplicate startup audio record.");
    ids.add(item.id);
    files.push(Object.freeze({ id: item.id, name: item.name, format: item.format, duration: item.duration }));
  }
  if (files.length > 16 || (input.activeAudioId !== null && !ids.has(input.activeAudioId))) throw new Error("Invalid startup audio selection.");
  return Object.freeze({ version: DOCUMENT_VERSION, activeAudioId: input.activeAudioId as string | null, files: Object.freeze(files) });
}
function mp3Duration(bytes: Buffer): number {
  let offset = 0;
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "ID3") {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
  }
  const bitrates: Record<number, number[]> = {
    1: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
    2: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
    25: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
  };
  const rates: Record<number, number[]> = { 1: [44100,48000,32000], 2: [22050,24000,16000], 25: [11025,12000,8000] };
  let seconds = 0, frames = 0, cursor = offset;
  while (cursor + 4 <= bytes.length) {
    if (bytes[cursor] !== 0xff || (bytes[cursor + 1] & 0xe0) !== 0xe0) { cursor += 1; continue; }
    const versionBits = (bytes[cursor + 1] >> 3) & 3;
    const layerBits = (bytes[cursor + 1] >> 1) & 3;
    const bitrateIndex = bytes[cursor + 2] >> 4;
    const rateIndex = (bytes[cursor + 2] >> 2) & 3;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) { cursor += 1; continue; }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
    const bitrate = bitrates[version]?.[bitrateIndex] ?? 0;
    const sampleRate = rates[version]?.[rateIndex] ?? 0;
    if (!bitrate || !sampleRate) { cursor += 1; continue; }
    const padding = (bytes[cursor + 2] >> 1) & 1;
    const frameLength = Math.floor((version === 1 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding;
    if (frameLength < 24 || cursor + frameLength > bytes.length) break;
    seconds += version === 1 ? 1152 / sampleRate : 576 / sampleRate;
    frames += 1;
    cursor += frameLength;
  }
  if (frames < 2 || seconds <= 0) throw new TypeError("The MP3 file is malformed or contains no decodable frames.");
  return seconds;
}
function oggDuration(bytes: Buffer): number {
  let offset = 0, sampleRate = 0, codec: "vorbis" | "opus" | null = null, lastGranule = 0n, pages = 0;
  while (offset + 27 <= bytes.length) {
    if (bytes.toString("ascii", offset, offset + 4) !== "OggS" || bytes[offset + 4] !== 0) {
      throw new TypeError("The Ogg container is malformed.");
    }
    const segments = bytes[offset + 26];
    if (offset + 27 + segments > bytes.length) throw new TypeError("The Ogg page is truncated.");
    let bodyLength = 0;
    for (let i = 0; i < segments; i += 1) bodyLength += bytes[offset + 27 + i];
    const bodyStart = offset + 27 + segments;
    const pageEnd = bodyStart + bodyLength;
    if (pageEnd > bytes.length) throw new TypeError("The Ogg page body is truncated.");
    const granule = bytes.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn) lastGranule = granule;
    if (pages === 0) {
      const packet = bytes.subarray(bodyStart, Math.min(pageEnd, bodyStart + 64));
      if (packet.length >= 16 && packet[0] === 1 && packet.toString("ascii", 1, 7) === "vorbis") {
        codec = "vorbis";
        sampleRate = packet.readUInt32LE(12);
      } else if (packet.length >= 19 && packet.toString("ascii", 0, 8) === "OpusHead") {
        codec = "opus";
        sampleRate = 48000;
      }
    }
    pages += 1;
    offset = pageEnd;
  }
  if (offset !== bytes.length || pages < 2 || !codec || !sampleRate || lastGranule <= 0n) {
    throw new TypeError("Only valid Ogg Vorbis or Opus audio files are supported.");
  }
  return Number(lastGranule) / sampleRate;
}
function inspectAudio(fileName: string, input: Uint8Array): { format: "mp3" | "ogg"; duration: number; mimeType: "audio/mpeg" | "audio/ogg" } {
  if (!(input instanceof Uint8Array) || input.byteLength < 32 || input.byteLength > MAX_AUDIO_BYTES) {
    throw new RangeError("Audio files must be between 32 bytes and 5 MiB.");
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const extension = fileName.toLowerCase().split(".").pop();
  let format: "mp3" | "ogg", duration: number;
  if (extension === "mp3" && (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
    format = "mp3"; duration = mp3Duration(bytes);
  } else if (extension === "ogg" && bytes.toString("ascii", 0, 4) === "OggS") {
    format = "ogg"; duration = oggDuration(bytes);
  } else {
    throw new TypeError("Choose a valid .mp3 or .ogg audio file.");
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) {
    throw new RangeError("Startup audio must be longer than 0 and no more than 3 seconds.");
  }
  return { format, duration, mimeType: format === "mp3" ? "audio/mpeg" : "audio/ogg" };
}
function cleanName(fileName: string): string {
  const name = fileName.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || "Startup sound").slice(0, 120);
}

export class AudioStore {
  readonly directory: string;
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();
  constructor(options: AudioStoreOptions) {
    if (!options || typeof options.directory !== "string" || !options.directory) throw new TypeError("An audio library directory is required.");
    this.directory = resolve(options.directory);
    this.#filePath = join(this.directory, "audio.json");
  }
  async #ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Audio library must be a non-symlink directory.");
    await chmod(this.directory, 0o700);
  }
  async #read(): Promise<AudioDocument> {
    try {
      const info = await lstat(this.#filePath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Audio metadata must be a private regular file (mode 0600).");
      return parseDocument(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ version: DOCUMENT_VERSION, activeAudioId: null, files: Object.freeze([]) });
      throw new Error("Unable to read audio library; refusing to overwrite it.", { cause: error });
    }
  }
  async #write(document: AudioDocument): Promise<void> {
    await this.#ensureDirectory();
    const temporary = join(this.directory, ".audio-" + randomBytes(8).toString("hex") + ".tmp");
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, this.#filePath);
      await chmod(this.#filePath, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("Unable to atomically update audio library metadata.", { cause: error });
    }
  }
  async list(): Promise<readonly ImportedAudio[]> {
    await this.#queue;
    const document = await this.#read();
    return Object.freeze(document.files.map((file) => Object.freeze({ ...file, active: file.id === document.activeAudioId })));
  }
  async importAudio(fileName: unknown, input: unknown): Promise<ImportedAudio> {
    if (typeof fileName !== "string" || fileName.length < 1 || fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(fileName)) throw new TypeError("Invalid audio file name.");
    const inspected = inspectAudio(fileName, input as Uint8Array);
    const bytes = Buffer.from(input as Uint8Array);
    const id = randomBytes(16).toString("hex");
    const operation = this.#queue.then(async () => {
      await this.#ensureDirectory();
      const current = await this.#read();
      if (current.files.length >= 16) throw new RangeError("The audio library can contain at most 16 files.");
      const target = join(this.directory, id + "." + inspected.format);
      const temporary = join(this.directory, "." + id + ".tmp");
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
        const record = Object.freeze({ id, name: cleanName(fileName), format: inspected.format, duration: Number(inspected.duration.toFixed(3)) });
        await this.#write(Object.freeze({ version: DOCUMENT_VERSION, activeAudioId: current.activeAudioId, files: Object.freeze([...current.files, record]) }));
        return Object.freeze({ ...record, active: false });
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async select(id: unknown): Promise<void> {
    if (id !== null && (typeof id !== "string" || !AUDIO_ID.test(id))) throw new TypeError("Invalid audio ID.");
    const operation = this.#queue.then(async () => {
      const current = await this.#read();
      if (id !== null && !current.files.some((file) => file.id === id)) throw new Error("The selected audio is not installed.");
      await this.#write(Object.freeze({ ...current, activeAudioId: id as string | null }));
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async remove(id: unknown): Promise<void> {
    if (typeof id !== "string" || !AUDIO_ID.test(id)) throw new TypeError("Invalid audio ID.");
    const operation = this.#queue.then(async () => {
      const current = await this.#read();
      const file = current.files.find((item) => item.id === id);
      if (!file) throw new Error("The selected audio is not installed.");
      const target = join(this.directory, id + "." + file.format);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Audio file must be a regular, non-symlink file.");
      await this.#write(Object.freeze({ version: DOCUMENT_VERSION, activeAudioId: current.activeAudioId === id ? null : current.activeAudioId, files: Object.freeze(current.files.filter((item) => item.id !== id)) }));
      await unlink(target);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async getActive(): Promise<ActiveAudio | null> {
    await this.#queue;
    const document = await this.#read();
    if (!document.activeAudioId) return null;
    const file = document.files.find((item) => item.id === document.activeAudioId);
    if (!file) return null;
    const target = join(this.directory, file.id + "." + file.format);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 32 || info.size > MAX_AUDIO_BYTES) throw new Error("Active audio file is missing or unsafe.");
    const bytes = await readFile(target);
    const inspected = inspectAudio(file.name, bytes);
    if (inspected.format !== file.format || Math.abs(inspected.duration - file.duration) > 0.01) throw new Error("Stored startup audio failed validation.");
    return Object.freeze({ ...file, active: true, bytes: new Uint8Array(bytes), mimeType: inspected.mimeType });
  }
}
