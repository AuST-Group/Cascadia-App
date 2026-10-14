// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { defineManagedResource } from '@cascadia/commons/managed-resources/index'
import type { ResourceLifetime } from '@cascadia/commons/managed-resources/index'
import type { TourPresentation, TourPresentationFactory } from './ports'

export const presentationResource = defineManagedResource({
  acquire(
    input: {
      factory: TourPresentationFactory
      onAcknowledge: () => void
    },
    lifetime: ResourceLifetime,
  ): TourPresentation {
    return input.factory({ onAcknowledge: lifetime.guard(input.onAcknowledge) })
  },
  dispose: (presentation) => presentation.destroy(),
}).withOperations({
  show: (presentation: TourPresentation) => presentation.show(),
})
