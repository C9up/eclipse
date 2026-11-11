# @c9up/eclipse

Distributed locks for the Ream framework. One name, one holder — everything
else is a store detail.

```bash
pnpm add @c9up/eclipse
```

## Why

Without a shared lock, every instance of an application does everything: a
nightly invoice run goes out N times, a cache miss recomputes N times, a job is
processed N times. Nothing in the logs says so.

## Configure

```ts
// config/lock.ts
import { defineConfig, stores } from "@c9up/eclipse"

export default defineConfig({
  default: "redis",
  stores: {
    memory: stores.memory(),
    redis: stores.redis({ connection: "main" }),
  },
})
```

```ts
// reamrc.ts
providers: [() => import("@c9up/eclipse/provider")]
```

`stores.redis({ connection })` names a `@c9up/quasar` connection, resolved on
the first lock — quasar is an optional peer, so an app locking in memory never
installs it. Pass `{ client }` instead to hand over a client directly.

`ream configure @c9up/eclipse` writes both, sets `LOCK_STORE=redis` and declares
its validation (`redis` or `memory`). The provider refuses to boot without
`config/lock.ts`, and `defineConfig` refuses a config whose `default` is unset
or names no declared store: an in-process fallback would let every replica take
every lock.

## Use

```ts
import locks from "@c9up/eclipse/services/main"

// run once across every replica; the losers do nothing
const [ran, invoices] = await locks
  .createLock("invoices:nightly", "5m")
  .runImmediately(async () => generateInvoices())

// wait for whoever holds it, then proceed — the cache-stampede shape
const [, user] = await locks
  .createLock(`user:${id}`, "30s")
  .run(async () => loadAndCacheUser(id))
```

`run` returns `[true, result]` or `[false, null]`, so "ran and returned
undefined" is distinguishable from "never ran".

For work whose length is genuinely unknown, take a short lease and push it out
rather than taking a long one — a lease sized for the worst case is also how
long the key stays stuck after a crash:

```ts
const lock = locks.createLock("import", "30s")
if (await lock.acquireImmediately()) {
  try {
    for (const batch of batches) {
      await process(batch)
      await lock.extend("30s")
    }
  } finally {
    await lock.release()
  }
}
```

## Durations

A bare number is **milliseconds** (`@c9up/echo` is seconds-native; each is
native to its own layer). Strings take the usual units: `"500ms"`, `"30s"`,
`"5m"`, `"2h"`. `null` never expires. Any other string, an unknown unit
included, throws `InvalidDurationError` (`E_ECLIPSE_INVALID_DURATION`).

## With the scheduler

```ts
// config/scheduler.ts
import { defineConfig } from "@c9up/ream/scheduler/config"
import locks from "@c9up/eclipse/services/main"
import { schedulerBackend } from "@c9up/eclipse/scheduler"

export default defineConfig({ lock: schedulerBackend(() => locks) })
```

`@c9up/ream` does not depend on eclipse — the scheduler declares a narrow
two-method contract and eclipse satisfies it, so the core works with no lock
package installed.

The lease is renewed every third of its TTL while the task runs, so a task
longer than the TTL never runs on two instances at once; the TTL only bounds how
long the name stays taken after an instance dies. `ttl` overrides the single TTL
the scheduler passes for every task, and `onLeaseLost(name, error)` is told when
a running task's lease was taken by someone else (a process warning otherwise).

## Safety

Every lease carries a random owner token, and release and extend compare it
inside the store — on Redis, in a Lua script, so the check and the delete are
one atomic step. Without that, work that outlives its own TTL deletes the lease
a *different* instance has since taken, freeing the name while work is still
running under it.

Losing a lease mid-work is reported as `E_LOCK_NOT_OWNED`, uniformly across
stores: `Lock.run` rejects with it when the callback succeeded but the lease
lapsed while it ran, since another holder may have run at the same time. When
the callback itself threw, `Lock.run` rethrows that error unchanged and a failed
release does not replace it.

## Testing

```ts
import { fakeLocks } from "@c9up/eclipse/testing"

const restore = fakeLocks(app.container)
afterEach(restore)
```

The teardown puts back the manager the fake replaced. Given the container, the
fake also stands behind its `LockManager`, `lock` and `eclipse.lock` bindings.

## License

MIT
