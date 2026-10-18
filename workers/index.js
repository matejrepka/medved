import { httpServerHandler } from "cloudflare:node";
import app from "../server.js";
import { withWorkerContext } from "./platform.js";

app.listen(3000);
const handler = httpServerHandler({ port: 3000 });

export default {
  fetch(request, env, ctx) {
    // Only Cloudflare's verified client IP reaches Express's one-hop proxy
    // handling. Discard any client-supplied forwarding chain.
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "127.0.0.1");
    headers.set("x-forwarded-proto", new URL(request.url).protocol.slice(0, -1));
    const forwarded = new Request(request, { headers });
    return withWorkerContext({ request: forwarded, env, ctx }, () => handler.fetch(forwarded, env, ctx));
  },
};
