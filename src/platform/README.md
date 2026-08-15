# Platform abstraction

Ovid's request handlers talk to a database and an object store through the
narrow interfaces in `types.ts` rather than to Cloudflare bindings directly.
This is what lets the same handler code run on Workers (the hosted ovid.ink)
and on a self-hosted Node server.

## How it works

`OvidDatabase` / `OvidStorage` are defined as a **subset of the D1/R2
shapes**. TypeScript is structurally typed, so `D1Database` and `R2Bucket`
already satisfy them:

```ts
// wrangler passes the real bindings; no wrapper, no runtime cost
const env: Env = { DB: /* D1Database */, ASSETS_BUCKET: /* R2Bucket */, ... };
```

A self-hosted deployment supplies its own implementations over SQLite and the
local filesystem (`server/`, added in a follow-up), and the
handlers are unchanged.

## Rules for changing these interfaces

1. **Keep them narrow.** Every method here is one a self-host adapter must
   reimplement. Today that surface is `prepare/bind/first/all/run`, `batch`,
   and `get/put/head/delete`.
2. **Stay a subset of D1/R2.** If a new method isn't part of the D1/R2 API
   with the same semantics, the Cloudflare pass-through breaks and needs a
   real wrapper.
3. **Keep SQL portable SQLite.** The self-host target is SQLite, so D1's
   dialect is the shared baseline. `json_extract`/`json_each` are fine;
   Postgres-only or D1-only syntax is not.
4. **Don't reach for `cloudflare:` imports in shared code.** The one place
   that does (`worker/translation/workflow.ts`, the optional Workflows
   translation backend) is deliberately isolated and is not part of the
   self-host path.
