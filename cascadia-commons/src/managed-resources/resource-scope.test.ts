// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { describe, expect, it } from 'vitest'
import { defineManagedResource } from './resource-definition'
import { createResourceScope } from './resource-scope'
import type { ResourceLifetime } from './resource-definition'
import type { Acquisition } from './resource-scope'

function acquireOrThrow<TOperations>(result: Acquisition<TOperations>) {
  if (result.kind !== 'acquired') throw new Error('Fixture acquisition failed')
  return result.lease
}
describe('managed resource ownership', () => {
  it('expires handles and callbacks before any reentrant disposal runs', async () => {
    const effects: Array<string> = []
    const scope = createResourceScope(() => undefined)
    let lateCallback: () => unknown = () => undefined
    const definition = defineManagedResource({
      acquire(name: string, lifetime: ResourceLifetime): string {
        lateCallback = lifetime.guard(() => effects.push('late callback'))
        return name
      },
      dispose(name) {
        effects.push(`dispose:${name}`)
        lateCallback()
        void scope.dispose()
      },
    }).withOperations({
      write: (name: string, text: string) => effects.push(`${name}:${text}`),
    })
    const first = acquireOrThrow(scope.acquire(definition, 'first'))
    const second = acquireOrThrow(scope.acquire(definition, 'second'))
    expect(await first.handle.write('before')).toMatchObject({
      kind: 'applied',
    })
    const disposed = scope.dispose()
    expect(scope.dispose()).toBe(disposed)
    expect(await second.handle.write('after')).toEqual({ kind: 'expired' })
    lateCallback()
    await disposed
    await first.release()
    expect(effects).toEqual(['first:before', 'dispose:second', 'dispose:first'])
    expect(scope.acquire(definition, 'third')).toEqual({ kind: 'closed' })
  })
  it('releases partial acquisitions and continues after cleanup failures', async () => {
    const effects: Array<string> = []
    const errors: Array<unknown> = []
    const failure = new Error('Failed acquisition')
    const cleanupFailure = new Error('Failed cleanup')
    const scope = createResourceScope((error) => errors.push(error))
    const definition = defineManagedResource({
      acquire(_input: undefined, lifetime) {
        lifetime.onDispose(() => {
          effects.push('first')
        })
        lifetime.onDispose(() => {
          effects.push('second')
          return Promise.reject(cleanupFailure)
        })
        throw failure
      },
      dispose: () => undefined,
    }).withOperations({})
    expect(scope.acquire(definition, undefined)).toEqual({
      kind: 'failed',
      error: failure,
    })
    await Promise.resolve()
    expect(effects).toEqual(['second', 'first'])
    expect(errors).toEqual([cleanupFailure])
  })
  it('awaits asynchronous cleanup while containing diagnostic failures', async () => {
    const scope = createResourceScope(() => {
      throw new Error('Diagnostic failure')
    })
    const cleanupFailure = new Error('Cleanup failure')
    let finish: () => void = () => undefined
    const definition = defineManagedResource({
      acquire: () => 'resource',
      dispose: () =>
        new Promise<void>((_resolve, reject) => {
          finish = () => reject(cleanupFailure)
        }),
    }).withOperations({})
    acquireOrThrow(scope.acquire(definition, undefined))
    let disposed = false
    const report = scope.dispose().then((value) => {
      disposed = true
      return value
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finish()
    expect(await report).toEqual({ errors: [cleanupFailure] })
  })
  it('suppresses an asynchronous result after release, without claiming rollback', async () => {
    const effects: Array<string> = []
    let finish: (value: string) => void = () => undefined
    const definition = defineManagedResource({
      acquire: () => 'connection',
      dispose: () => undefined,
    }).withOperations({
      send(connection: string, message: string) {
        effects.push(`${connection}:${message}`)
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      },
    })
    const scope = createResourceScope(() => undefined)
    const owned = acquireOrThrow(scope.acquire(definition, undefined))
    const response = owned.handle.send('written')
    await owned.release()
    finish('late result')
    expect(await response).toEqual({ kind: 'expired' })
    expect(effects).toEqual(['connection:written'])
  })
  it('releases a resource returned after reentrant scope disposal', async () => {
    const effects: Array<string> = []
    const scope = createResourceScope(() => undefined)
    let lifetime: ResourceLifetime | undefined
    let finishCleanup: () => void = () => undefined
    const definition = defineManagedResource({
      acquire(_input: undefined, acquiredLifetime) {
        lifetime = acquiredLifetime
        void scope.dispose()
        return 'late acquisition'
      },
      dispose(resource) {
        effects.push(resource)
        return new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
      },
    }).withOperations({})
    expect(scope.acquire(definition, undefined)).toEqual({ kind: 'closed' })
    expect(lifetime?.signal.aborted).toBe(true)
    expect(effects).toEqual(['late acquisition'])
    let settled = false
    const cleanup = scope.dispose().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    finishCleanup()
    await cleanup
  })
  it('derives exact operation arguments and results without exposing the resource', async () => {
    const definition = defineManagedResource({
      acquire: (count: number) => ({ count }),
      dispose: () => undefined,
    }).withOperations({
      add: (
        resource: {
          count: number
        },
        amount: number,
      ) => resource.count + amount,
    })
    const scope = createResourceScope(() => undefined)
    const owned = acquireOrThrow(scope.acquire(definition, 4))
    expect(await owned.handle.add(3)).toEqual({ kind: 'applied', value: 7 })
    void (() => {
      // @ts-expect-error Operation arguments come from the declaration.
      void owned.handle.add('3')
      // @ts-expect-error Consumers cannot access the raw resource.
      owned.handle.resource
      // @ts-expect-error Disposal authority belongs to the lease owner.
      owned.handle.dispose()
      // @ts-expect-error Definitions expose no untracked raw acquisition path.
      definition.acquire(4)
      defineManagedResource({
        // @ts-expect-error Async work acquires a controller, not an unowned promise.
        acquire: () => Promise.resolve('resource'),
        dispose: () => undefined,
      })
    })
    await scope.dispose()
  })
})
