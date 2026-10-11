import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The Workers build substitutes workers/platform.js for this module.
export const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
export const isWorker = false;
export const readText = (filename) => readFile(filename, "utf8");
export const defer = (promise) => { void promise; };
export const serveAssets = (_req, _res, next) => next();
