// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { resourceImplementation } from './resource-definition'
import type {
  Finalizer,
  OperationOutcome,
  ResourceDefinition,
  ResourceHandle,
  ResourceLifetime,
  ResourceOperations,
} from './resource-definition'

export interface CleanupReport {
  readonly errors: ReadonlyArray<unknown>
}

/** The owner keeps release authority; consumers receive only `handle`. */
export interface ResourceLease<TOperations> {
  readonly handle: ResourceHandle<TOperations>
  release: () => Promise<CleanupReport>
}

export type Acquisition<TOperations> =
  | { kind: 'acquired'; lease: ResourceLease<TOperations> }
  | { kind: 'closed' }
  | { kind: 'failed'; error: unknown }

export interface ResourceScope {
  acquire: <
    TInput,
    TResource,
    TOperations extends ResourceOperations<TResource>,
  >(
    definition: ResourceDefinition<TInput, TResource, TOperations>,
    input: TInput,
  ) => Acquisition<TOperations>
  dispose: () => Promise<CleanupReport>
}

/**
 * Owns resources, not business completion or remote rollback. All resources
 * expire before disposal starts. Finalizers start in reverse registration
 * order; dependent asynchronous cleanup belongs inside one finalizer.
 */
export function createResourceScope(
  onCleanupError: (error: unknown) => void,
): ResourceScope {
  let closed = false
  let disposal: Promise<CleanupReport> | undefined
  const registrations = new Set<ResourceRegistration>()

  return {
    acquire(definition, input) {
      if (closed) return { kind: 'closed' }
      const registration = createRegistration(onCleanupError)
      registrations.add(registration)
      const release = () => {
        registration.expire()
        registrations.delete(registration)
        return registration.finalize()
      }
      try {
        const implementation = resourceImplementation(definition)
        const resource = implementation.acquire(input, registration.lifetime)
        registration.lifetime.onDispose(() => implementation.dispose(resource))
        if (!registration.isLive()) {
          void release()
          return { kind: 'closed' }
        }
        return {
          kind: 'acquired',
          lease: {
            handle: bindOperations(
              implementation.operations,
              resource,
              registration,
            ),
            release,
          },
        }
      } catch (error) {
        void release()
        return { kind: 'failed', error }
      }
    },
    dispose() {
      if (disposal) return disposal
      closed = true
      const owned = [...registrations].reverse()
      registrations.clear()
      let settled: (report: CleanupReport) => void = () => undefined
      disposal = new Promise((resolve) => {
        settled = resolve
      })
      // Invalidating the whole scope precedes potentially reentrant cleanup.
      for (const registration of owned) registration.expire()
      void Promise.all(owned.map((entry) => entry.finalize())).then((reports) =>
        settled({ errors: reports.flatMap((report) => report.errors) }),
      )
      return disposal
    },
  }
}

interface ResourceRegistration {
  lifetime: ResourceLifetime
  isLive: () => boolean
  expire: () => void
  finalize: () => Promise<CleanupReport>
}

function createRegistration(
  onCleanupError: (error: unknown) => void,
): ResourceRegistration {
  let live = true
  let disposal: Promise<CleanupReport> | undefined
  const controller = new AbortController()
  const finalizers: Array<Finalizer> = []
  const pendingCleanup: Array<Promise<void>> = []
  let cleanupSettled = false
  const errors: Array<unknown> = []

  const reportError = (error: unknown) => {
    errors.push(error)
    // Diagnostic failure cannot prevent another resource's cleanup.
    try {
      onCleanupError(error)
    } catch {
      // The original error remains in the cleanup report.
    }
  }
  const runFinalizer = (finalizer: Finalizer): Promise<void> => {
    try {
      return Promise.resolve(finalizer()).catch(reportError)
    } catch (error) {
      reportError(error)
      return Promise.resolve()
    }
  }

  return {
    lifetime: {
      signal: controller.signal,
      onDispose(finalizer) {
        if (live) finalizers.push(finalizer)
        else {
          const cleanup = runFinalizer(finalizer)
          if (!cleanupSettled) pendingCleanup.push(cleanup)
        }
      },
      guard(callback) {
        return (...args) => (live ? callback(...args) : undefined)
      },
    },
    isLive: () => live,
    expire() {
      live = false
    },
    finalize() {
      if (disposal) return disposal
      // Publish the promise before abort listeners or finalizers can reenter.
      let settled: (report: CleanupReport) => void = () => undefined
      disposal = new Promise((resolve) => {
        settled = resolve
      })
      controller.abort()
      pendingCleanup.push(...finalizers.reverse().map(runFinalizer))
      finalizers.length = 0
      // A reentrant acquisition can return and register its finalizer after
      // disposal started. Drain additions before reporting settled cleanup.
      void Promise.resolve().then(async () => {
        while (pendingCleanup.length > 0) {
          await Promise.all(pendingCleanup.splice(0))
        }
        cleanupSettled = true
        settled({ errors: [...errors] })
      })
      return disposal
    },
  }
}

function bindOperations<
  TResource,
  TOperations extends ResourceOperations<TResource>,
>(
  operations: TOperations,
  resource: TResource,
  registration: ResourceRegistration,
): ResourceHandle<TOperations> {
  const bound = Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      async (...args: Array<unknown>): Promise<OperationOutcome<unknown>> => {
        if (!registration.isLive()) return { kind: 'expired' }
        try {
          // The public mapped type preserves each operation's exact arguments;
          // erasure is confined to this single runtime binding boundary.
          const invoke = operation as (
            value: TResource,
            ...arguments_: Array<unknown>
          ) => unknown
          const value = await invoke(resource, ...args)
          return registration.isLive()
            ? { kind: 'applied', value }
            : { kind: 'expired' }
        } catch (error) {
          return { kind: 'failed', error }
        }
      },
    ]),
  )
  return Object.freeze(bound) as ResourceHandle<TOperations>
}
