import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "runtime", "assets");
const destination = path.join(root, "dist", "runtime", "assets");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
