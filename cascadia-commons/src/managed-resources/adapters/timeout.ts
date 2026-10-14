// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { defineManagedResource } from '../resource-definition'

export const scheduledTask = defineManagedResource({
  acquire(
    input: {
      delayMs: number
      run: () => void
    },
    lifetime,
  ) {
    return setTimeout(lifetime.guard(input.run), input.delayMs)
  },
  dispose: (timer) => clearTimeout(timer),
}).withOperations({})
