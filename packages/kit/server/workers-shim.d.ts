// Loose Workers declarations for DOM + Bun typecheck projects (tests and scripts) that reach a Durable Object module
// through an import, such as a test importing `server/room.ts` for its RoomCore. The server projects check these
// modules against @cloudflare/workers-types; never include this file alongside them.

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
    fetch?(request: Request): Response | Promise<Response>
  }
}

interface DurableObjectState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    put<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<boolean>
  }
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}
interface DurableObjectNamespace<_T = unknown> {
  idFromName(name: string): any
  get(id: any): any
}
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket & { accept(): void } } }
interface ResponseInit {
  webSocket?: WebSocket | null
}
