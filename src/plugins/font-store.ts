/**
 * Host-owned TrueType font library.
 *
 * Renderer/plugin code receives font bytes only for the currently active
 * font. Imported files are copied into a private directory under generated
 * names; untrusted source paths are never retained.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DOCUMENT_VERSION = 1 as const;
const FONT_ID = /^[a-f0-9]{32}$/;
const MAX_FONT_BYTES = 12 * 1024 * 1024;

interface FontRecord {
  readonly id: string;
  readonly name: string;
}
interface FontDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly activeFontId: string | null;
  readonly fonts: readonly FontRecord[];
}
export interface ImportedFont {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
}
export interface ActiveFont extends ImportedFont {
  readonly family: string;
  readonly bytes: Uint8Array;
}
export interface FontStoreOptions {
  readonly directory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(input: unknown): FontDocument {
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "activeFontId,fonts,version" ||
      input.version !== DOCUMENT_VERSION || !Array.isArray(input.fonts) ||
      (input.activeFontId !== null && (typeof input.activeFontId !== "string" || !FONT_ID.test(input.activeFontId)))) {
    throw new Error("Invalid font library document.");
  }
  const ids = new Set<string>();
  const fonts: FontRecord[] = [];
  for (const item of input.fonts) {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "id,name" ||
        typeof item.id !== "string" || !FONT_ID.test(item.id) ||
        typeof item.name !== "string" || item.name.length < 1 || item.name.length > 100) {
      throw new Error("Invalid font library record.");
    }
    if (ids.has(item.id)) throw new Error("Duplicate font library record.");
    ids.add(item.id);
    fonts.push(Object.freeze({ id: item.id, name: item.name }));
  }
  if (input.activeFontId !== null && !ids.has(input.activeFontId)) {
    throw new Error("The active font is missing from the font library.");
  }
  return Object.freeze({
    version: DOCUMENT_VERSION,
    activeFontId: input.activeFontId as string | null,
    fonts: Object.freeze(fonts),
  });
}

function extractFamilyName(bytes: Buffer, fallback: string): string {
  if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0x00010000) {
    throw new TypeError("Only TrueType (.ttf) fonts are supported.");
  }
  const tableCount = bytes.readUInt16BE(4);
  let nameOffset = -1;
  let nameLength = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (record + 16 > bytes.length) throw new TypeError("The TTF table directory is malformed.");
    if (bytes.toString("ascii", record, record + 4) === "name") {
      nameOffset = bytes.readUInt32BE(record + 8);
      nameLength = bytes.readUInt32BE(record + 12);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + nameLength > bytes.length || nameLength < 6) return fallback;
  const count = bytes.readUInt16BE(nameOffset + 2);
  const stringsOffset = bytes.readUInt16BE(nameOffset + 4);
  let preferred: string | undefined;
  for (let index = 0; index < count; index += 1) {
    const record = nameOffset + 6 + index * 12;
    if (record + 12 > nameOffset + nameLength) break;
    const platform = bytes.readUInt16BE(record);
    const language = bytes.readUInt16BE(record + 4);
    const nameId = bytes.readUInt16BE(record + 6);
    const length = bytes.readUInt16BE(record + 8);
    const offset = bytes.readUInt16BE(record + 10);
    if (nameId !== 1 || stringsOffset + offset + length > nameLength) continue;
    const value = bytes.subarray(nameOffset + stringsOffset + offset, nameOffset + stringsOffset + offset + length);
    let decoded = "";
    if (platform === 0 || platform === 3) {
      const evenLength = value.length - (value.length % 2);
      const utf16 = Buffer.from(value.subarray(0, evenLength));
      utf16.swap16();
      decoded = utf16.toString("utf16le");
    } else if (platform === 1) {
      decoded = value.toString("latin1");
    }
    decoded = decoded.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!decoded || decoded.length > 100) continue;
    if (language === 0x0409 || language === 0) return decoded;
    preferred ??= decoded;
  }
  return preferred ?? fallback;
}

function cleanFallback(fileName: string): string {
  const base = fileName.replace(/\.ttf$/i, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "Imported Font").slice(0, 100);
}

export class FontStore {
  readonly directory: string;
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: FontStoreOptions) {
    if (!options || typeof options.directory !== "string" || options.directory.length === 0) {
      throw new TypeError("A font library directory is required.");
    }
    this.directory = resolve(options.directory);
    this.#filePath = join(this.directory, "fonts.json");
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Font library must be a non-symlink directory.");
    }
    await chmod(this.directory, 0o700);
  }

  async #read(): Promise<FontDocument> {
    try {
      const info = await lstat(this.#filePath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error("Font library metadata must be a private regular file (mode 0600).");
      }
      return parseDocument(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({ version: DOCUMENT_VERSION, activeFontId: null, fonts: Object.freeze([]) });
      }
      throw new Error("Unable to read font library; refusing to overwrite it.", { cause: error });
    }
  }

  async #write(document: FontDocument): Promise<void> {
    await this.#ensureDirectory();
    const temporary = join(this.directory, ".fonts-" + randomBytes(8).toString("hex") + ".tmp");
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      await rename(temporary, this.#filePath);
      await chmod(this.#filePath, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("Unable to atomically update font library metadata.", { cause: error });
    }
  }

  async list(): Promise<readonly ImportedFont[]> {
    await this.#queue;
    const document = await this.#read();
    return Object.freeze(document.fonts.map((font) => Object.freeze({
      ...font,
      active: font.id === document.activeFontId,
    })));
  }

  async importFont(fileName: unknown, input: unknown): Promise<ImportedFont> {
    if (typeof fileName !== "string" || fileName.length < 1 || fileName.length > 255 ||
        !/\.ttf$/i.test(fileName) || /[\u0000-\u001f\u007f]/.test(fileName)) {
      throw new TypeError("Choose a file with a .ttf extension.");
    }
    if (!(input instanceof Uint8Array) || input.byteLength < 12 || input.byteLength > MAX_FONT_BYTES) {
      throw new RangeError("TTF files must be between 12 bytes and 12 MiB.");
    }
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const name = extractFamilyName(bytes, cleanFallback(fileName));
    const id = randomBytes(16).toString("hex");
    const target = join(this.directory, id + ".ttf");
    const operation = this.#queue.then(async () => {
      await this.#ensureDirectory();
      const current = await this.#read();
      const temporary = join(this.directory, "." + id + ".tmp");
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
        await this.#write(Object.freeze({
          version: DOCUMENT_VERSION,
          activeFontId: current.activeFontId,
          fonts: Object.freeze([...current.fonts, Object.freeze({ id, name })]),
        }));
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
    return Object.freeze({ id, name, active: false });
  }

  async setActive(id: unknown): Promise<void> {
    if (id !== null && (typeof id !== "string" || !FONT_ID.test(id))) throw new TypeError("Invalid font ID.");
    const operation = this.#queue.then(async () => {
      const current = await this.#read();
      if (id !== null && !current.fonts.some((font) => font.id === id)) throw new Error("The selected font is not installed.");
      await this.#write(Object.freeze({ ...current, activeFontId: id as string | null }));
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async remove(id: unknown): Promise<void> {
    if (typeof id !== "string" || !FONT_ID.test(id)) throw new TypeError("Invalid font ID.");
    const operation = this.#queue.then(async () => {
      const current = await this.#read();
      const font = current.fonts.find((item) => item.id === id);
      if (!font) throw new Error("The selected font is not installed.");
      const file = join(this.directory, id + ".ttf");
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Font file must be a regular, non-symlink file.");
      await unlink(file);
      await this.#write(Object.freeze({
        version: DOCUMENT_VERSION,
        activeFontId: current.activeFontId === id ? null : current.activeFontId,
        fonts: Object.freeze(current.fonts.filter((item) => item.id !== id)),
      }));
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async getActive(): Promise<ActiveFont | null> {
    await this.#queue;
    const document = await this.#read();
    if (!document.activeFontId) return null;
    const font = document.fonts.find((item) => item.id === document.activeFontId);
    if (!font) return null;
    const file = join(this.directory, font.id + ".ttf");
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FONT_BYTES) {
      throw new Error("Active font file is missing or unsafe.");
    }
    const bytes = await readFile(file);
    if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0x00010000) {
      throw new Error("Stored active font is not a valid TrueType file.");
    }
    return Object.freeze({
      id: font.id,
      name: font.name,
      active: true,
      family: "YPlusPlusFont_" + font.id,
      bytes: new Uint8Array(bytes),
    });
  }
}
