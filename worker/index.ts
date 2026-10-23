/** The Workers routing pattern from the author's Proof of Patience, adapted to Do Not Feed It. */
import handler from "vinext/server/app-router-entry";
import { handleChainRequest, type ChainEnv } from "./chain";
interface Env extends ChainEnv { ASSETS: { fetch(request: Request): Promise<Response> } }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // The Node production preview calls fetch without Worker bindings.
    // Keep its chain routes in disabled practice mode, just like local dev.
    const chainResponse = await handleChainRequest(request, env ?? {});
    return chainResponse ?? handler.fetch(request, env, ctx);
  },
};
export default worker;
