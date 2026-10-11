import { AsyncLocalStorage } from "node:async_hooks";
import resources from "#worker-resources";

const requestContext = new AsyncLocalStorage();
export const projectDirectory = "/app";
export const isWorker = true;

export async function readText(filename) {
  if (!Object.hasOwn(resources, filename)) throw new Error(`Missing bundled resource: ${filename}`);
  return resources[filename];
}

export function withWorkerContext(context, operation) {
  return requestContext.run(context, operation);
}

export function defer(promise) {
  const context = requestContext.getStore();
  if (!context) throw new Error("Background work requires a Worker request context");
  context.ctx.waitUntil(promise);
}

// Let Express own dynamic pages/API routes and use the assets binding for the
// remaining files. Workers has no on-disk public/ or node_modules/ directory.
export async function serveAssets(req, res, next) {
  if (!["GET", "HEAD"].includes(req.method) || req.path.startsWith("/api/")) return next();
  try {
    const { env, request } = requestContext.getStore();
    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) return next();
    res.status(response.status);
    for (const [name, value] of response.headers) res.setHeader(name, value);
    if (req.method === "HEAD" || !response.body) return res.end();
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    next(error);
  }
}
