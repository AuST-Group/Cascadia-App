# Managed resources and typed progression

## What this feature is

Managed resources give an application owner a scope that tracks acquisition,
operations, callbacks and cleanup. Typed progression derives legal commands and
successor phases from a domain's state graph. These are independent contracts;
resource disposal does not decide business completion.

## Why you use it

Use a scope when imperative resources outlive a function call: an editor,
presentation, timer, subscription or controller for asynchronous work. Use
progression when legal next actions change with the phase. Simple React effects
with one correctly paired setup and cleanup do not require migration.

## Stable entry points

Import `defineManagedResource` and `createResourceScope` from
`@cascadia/commons/managed-resources/index`; import `defineProgression` from
`@cascadia/commons/progression/index`. `scheduledTask` is the portable timeout
adapter at `@cascadia/commons/managed-resources/adapters/timeout`.

## Core mental model

A declaration establishes acquisition and disposal, then `.withOperations()`
checks operations against the inferred resource type. The scope issues an owner
lease with `release()` and a consumer handle containing only declared operations.
The raw resource remains inside the declaration. React state observes the domain
controller rather than acting as its admission lock.
Definitions are opaque; their factories and raw operations are not exposed by
the public facade. `ResourceOperationsOf<typeof definition>` derives the operation
type when an owner needs to store a lease.

## How it executes

Acquisition is synchronous and registered before the factory runs. Use
`lifetime.onDispose()` for partial acquisitions before another fallible step,
`lifetime.guard()` for callbacks, and `lifetime.signal` for cooperative cancellation.
Asynchronous work belongs behind operations on an acquired controller.

Handle operations return promises containing `applied`, `expired` or `failed`.
Effects begin immediately when an operation is invoked; its result is checked
again after awaiting it. An expired result does not mean earlier effects were
undone. Release immediately invalidates its handle and callbacks, signals abort,
starts cleanup, and returns a cleanup report.

Scope disposal closes admission and invalidates all owned resources before any
cleanup. Finalizers start in reverse registration order. Independent asynchronous
finalizers are awaited together; put dependent cleanup inside one finalizer.
Cleanup errors are reported individually and do not skip remaining finalizers.
Repeated disposal returns the same promise.

## Small example

```ts
import { createResourceScope } from '@cascadia/commons/managed-resources/index'
import { scheduledTask } from '@cascadia/commons/managed-resources/adapters/timeout'

const scope = createResourceScope(console.error)
const pending = scope.acquire(scheduledTask, {
  delayMs: 1000,
  run: () => console.log('Owner is still live'),
})

if (pending.kind === 'acquired') {
  await pending.lease.release() // Cancels only this task.
}
await scope.dispose()
```

A rejected or duplicate request should return no cleanup authority. Never hand a
request a cancellation function that targets whichever resource happens to be
current later.

## Real example

An editor adapter can declare its vendor operations once:

```ts
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { defineManagedResource } from '@cascadia/commons/managed-resources/index'

const editorResource = defineManagedResource({
  acquire: (input: { parent: HTMLElement; initialText: string }) =>
    new EditorView({
      parent: input.parent,
      state: EditorState.create({ doc: input.initialText }),
    }),
  dispose: (view) => view.destroy(),
}).withOperations({
  readText: (view) => view.state.doc.toString(),
})
```

The owner acquires this declaration through its scope and gives consumers only
`lease.handle`. `readText()` returns an operation outcome containing a string;
the handle has no `destroy()` or raw editor access. Choose the owner's identity
from file and edit mode; a background content refetch should not recreate the
editor and erase unsaved edits. This is an adapter example, not a migration of
the existing source viewer.

The guided tour's controller owns a presentation lease and a delayed startup
lease. Its React provider creates a controller during layout setup and disposes
it during cleanup. Driver.js and browser storage live behind tour-owned adapters.
StrictMode's repeated setup receives a fresh controller; retained commands on the
disposed controller cannot reacquire resources.

The tour declares its progression once:

```ts
import { defineProgression } from '@cascadia/commons/progression/index'

const progression = defineProgression({
  idle: { start: 'active', dispose: 'disposed' },
  active: { acknowledge: 'idle', cancel: 'idle', dispose: 'disposed' },
  disposed: {},
})
const admission = progression.start('idle').commands.start()
if (admission.kind === 'advanced') {
  const dismissal = admission.phase.commands.acknowledge()
  // dismissal.evidence, when advanced, records this specific accepted edge.
}
```

The production tour also has scheduled, starting and settling phases. Its
completion store accepts acknowledgement evidence, so cancellation evidence
cannot be passed in its place. User dismissal counts as acknowledgement under
the existing product policy; route cancellation does not.

## How it relates to other features

An editor may need ownership without progression. Manufacturing execution state
belongs to the server; a screen scope owns its observation, not the durable run.
AI streams can own cancellation controllers and subscriptions while persisting
usage independently. Worker attempts still need database claims and broker
delivery identity. These systems are not migrated by the tour fix.

## Inspection and debugging

Inspect acquisition and operation outcomes, cleanup reports, and the domain's
snapshot. Progression yields `advanced`, `stale` or `invalid`; retained phase
aliases become stale after an accepted transition, including after a cycle
returns to a state with the same name. Commands and evidence types come from the
graph. `transition(command)` supports a typed command selected dynamically;
`commands.name()` is convenient when handling a union of phases.

## Anti-patterns

Do not use component unmount as a durable workflow cancellation, treat abort as
rollback, expose a raw-resource getter, or use React state to guard synchronous
admission. Custom adapter operations and registered finalizers are the extension
boundary. Shared resources should expose a per-owner subscription or lease,
rather than transferring disposal of the underlying shared object.
Finalizers must not await disposal of their own scope, which would wait on them
in turn.

## Current limits

Ownership and progression are local to one runtime. Transition evidence proves
a local edge, not external authorization or a durable commit. Remote responses
still require runtime validation, idempotency and reconciliation at their domain
boundary. Cancellation cannot forcibly stop an adapter that ignores its signal.

Cleanup awaits registered asynchronous finalizers; it has no built-in timeout.
Adapters and process owners must supply deadlines where shutdown can stall.
Finalizers registered after cleanup has already settled run immediately and
report failures through the error callback; a previously returned report cannot
promise to include future work. Resource handles must return domain data rather
than leaking raw vendor objects through operation results.

## Related docs

- [Testing guide](testing.md)
- [Application architecture](../architecture/overview.md)
