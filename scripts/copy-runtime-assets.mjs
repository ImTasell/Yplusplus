import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "runtime", "assets");
const destination = path.join(root, "dist", "src", "runtime", "assets");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });

const builtinFontsSource = path.join(root, "examples", "fonts-plugin");
const builtinFontsDestination = path.join(destination, "builtin-plugins", "fonts");
await mkdir(builtinFontsDestination, { recursive: true });
await cp(builtinFontsSource, builtinFontsDestination, { recursive: true, force: true });

const builtinHelloSource = path.join(root, "examples", "hello-plugin");
const builtinHelloDestination = path.join(destination, "builtin-plugins", "hello");
await mkdir(builtinHelloDestination, { recursive: true });
await cp(builtinHelloSource, builtinHelloDestination, { recursive: true, force: true });
