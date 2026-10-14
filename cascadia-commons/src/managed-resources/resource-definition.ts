// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

export type Finalizer = () => void | Promise<void>

export interface ResourceLifetime {
  readonly signal: AbortSignal
  /** Register partial acquisitions before the next fallible acquisition. */
  onDispose: (finalizer: Finalizer) => void
  /** Suppress callbacks after this resource loses ownership. */
  guard: <TArgs extends Array<unknown>, TResult>(
    callback: (...args: TArgs) => TResult,
  ) => (...args: TArgs) => TResult | undefined
}

export type ResourceOperations<TResource> = Record<
  string,
  (resource: TResource, ...args: Array<never>) => unknown
>

declare const definitionBrand: unique symbol

export interface ResourceDefinition<TInput, TResource, TOperations> {
  readonly [definitionBrand]: {
    input: TInput
    resource: TResource
    operations: TOperations
  }
}

export type ResourceOperationsOf<TDefinition> =
  TDefinition extends ResourceDefinition<
    infer _TInput,
    infer _TResource,
    infer TOperations
  >
    ? TOperations
    : never

interface ResourceImplementation<TInput, TResource, TOperations> {
  /** Acquire synchronously; asynchronous work belongs behind operations. */
  acquire: (
    input: TInput,
    lifetime: ResourceLifetime,
  ) => TResource &
    (NoInfer<TResource> extends PromiseLike<unknown> ? never : unknown)
  operations: TOperations
  dispose: (resource: TResource) => void | Promise<void>
}

const implementations = new WeakMap<object, unknown>()

/** Internal scope binding; consumers use the public facade and opaque definitions. */
export function resourceImplementation<TInput, TResource, TOperations>(
  definition: ResourceDefinition<TInput, TResource, TOperations>,
): ResourceImplementation<TInput, TResource, TOperations> {
  const implementation = implementations.get(definition)
  if (!implementation)
    throw new TypeError('Unrecognized managed resource definition')
  return implementation as ResourceImplementation<
    TInput,
    TResource,
    TOperations
  >
}

export type OperationOutcome<TValue> =
  | { kind: 'applied'; value: TValue }
  | { kind: 'expired' }
  | { kind: 'failed'; error: unknown }

export type ResourceHandle<TOperations> = {
  readonly [Name in keyof TOperations]: TOperations[Name] extends (
    resource: never,
    ...args: infer TArgs
  ) => infer TResult
    ? (...args: TArgs) => Promise<OperationOutcome<Awaited<TResult>>>
    : never
}

/** The definition is the sole source of input and bound-operation types. */
export function defineManagedResource<TInput, TResource>(definition: {
  acquire: (
    input: TInput,
    lifetime: ResourceLifetime,
  ) => TResource &
    (NoInfer<TResource> extends PromiseLike<unknown> ? never : unknown)
  dispose: (resource: NoInfer<TResource>) => void | Promise<void>
}) {
  // Establish the acquired type before checking operations against it. This
  // avoids inference cycles between acquisition and operation parameters.
  return {
    withOperations<TOperations extends ResourceOperations<TResource>>(
      operations: TOperations,
    ): ResourceDefinition<TInput, TResource, TOperations> {
      const implementation = Object.freeze({
        acquire: definition.acquire,
        dispose: definition.dispose,
        operations: Object.freeze({ ...operations }),
      })
      const opaque = Object.freeze({}) as ResourceDefinition<
        TInput,
        TResource,
        TOperations
      >
      implementations.set(opaque, implementation)
      return opaque
    },
  }
}
