// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

export { defineManagedResource } from './resource-definition'
export { createResourceScope } from './resource-scope'
export type {
  Finalizer,
  OperationOutcome,
  ResourceDefinition,
  ResourceHandle,
  ResourceLifetime,
  ResourceOperationsOf,
} from './resource-definition'
export type {
  Acquisition,
  CleanupReport,
  ResourceLease,
  ResourceScope,
} from './resource-scope'
