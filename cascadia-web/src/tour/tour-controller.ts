// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createResourceScope } from '@cascadia/commons/managed-resources/index'
import { scheduledTask } from '@cascadia/commons/managed-resources/adapters/timeout'
import { presentationResource } from './presentation-resource'
import { tourProgression } from './tour-progression'
import type {
  ResourceLease,
  ResourceOperationsOf,
} from '@cascadia/commons/managed-resources/index'
import type { TourPorts, TourSnapshot } from './ports'
import type { TourPhase } from './tour-progression'

const DASHBOARD_RENDER_DELAY_MS = 1000
const noCancellation = () => undefined

/** One controller per committed provider lifetime; React state is a projection. */
export function createTourController(ports: TourPorts) {
  const scope = createResourceScope(ports.onError)
  let phase: TourPhase = tourProgression.start('idle')
  let pending:
    ResourceLease<ResourceOperationsOf<typeof scheduledTask>> | undefined
  let presentation:
    ResourceLease<ResourceOperationsOf<typeof presentationResource>> | undefined

  function readCompleted(): boolean {
    try {
      return ports.completion.isCompleted()
    } catch (error) {
      ports.onError(error)
      return false
    }
  }

  function snapshot(): TourSnapshot {
    return {
      hasCompletedTour: readCompleted(),
      isTourActive: phase.state === 'active',
    }
  }

  function notify() {
    ports.onChange(snapshot())
  }

  function releasePending() {
    const owned = pending
    pending = undefined
    if (owned) void owned.release()
  }

  function releasePresentation() {
    const owned = presentation
    presentation = undefined
    if (owned) void owned.release()
  }

  function cancel() {
    if (
      phase.state === 'idle' ||
      phase.state === 'disposed' ||
      phase.state === 'settling'
    )
      return
    const next = phase.commands.cancel()
    if (next.kind !== 'advanced') return
    phase = next.phase
    releasePending()
    releasePresentation()
    const settled = next.phase.commands.finish()
    if (settled.kind === 'advanced') phase = settled.phase
    notify()
  }

  function acknowledge() {
    if (phase.state !== 'active') return
    const next = phase.commands.acknowledge()
    if (next.kind !== 'advanced') return
    phase = next.phase
    // User dismissal is acknowledgement under Cascadia's existing policy.
    // Route cancellation cannot mint acknowledgement evidence.
    try {
      ports.completion.record(next.evidence)
    } catch (error) {
      ports.onError(error)
    } finally {
      releasePresentation()
      const settled = next.phase.commands.finish()
      if (settled.kind === 'advanced') phase = settled.phase
      notify()
    }
  }

  function start() {
    if (phase.state !== 'idle' && phase.state !== 'scheduled') return
    const next = phase.commands.start()
    if (next.kind !== 'advanced') return
    // Reserve before acquisition or vendor callbacks can reenter.
    phase = next.phase
    releasePending()
    const acquired = scope.acquire(presentationResource, {
      factory: ports.presentation,
      onAcknowledge: acknowledge,
    })
    if (acquired.kind !== 'acquired') {
      cancel()
      if (acquired.kind === 'failed') ports.onError(acquired.error)
      return
    }
    const activation = next.phase.commands.activate()
    if (activation.kind !== 'advanced') {
      void acquired.lease.release()
      return
    }
    presentation = acquired.lease
    phase = activation.phase
    notify()
    const owned = acquired.lease
    void owned.handle.show().then((outcome) => {
      if (outcome.kind === 'failed') {
        if (presentation === owned) cancel()
        ports.onError(outcome.error)
      }
    })
  }

  function scheduleAutomaticStart(): () => void {
    if (phase.state !== 'idle' || readCompleted()) return noCancellation
    try {
      if (ports.completion.isAutomaticStartSuppressed()) return noCancellation
    } catch (error) {
      ports.onError(error)
      return noCancellation
    }
    const next = phase.commands.schedule()
    if (next.kind !== 'advanced') return noCancellation
    phase = next.phase
    const acquired = scope.acquire(scheduledTask, {
      delayMs: DASHBOARD_RENDER_DELAY_MS,
      run: () => {
        if (readCompleted()) cancel()
        else start()
      },
    })
    if (acquired.kind !== 'acquired') {
      cancel()
      if (acquired.kind === 'failed') ports.onError(acquired.error)
      return noCancellation
    }
    const owned = acquired.lease
    pending = owned
    // Duplicate requests own nothing; old cleanup cannot cancel replacement.
    return () => {
      if (pending === owned) cancel()
    }
  }

  function reset() {
    if (
      phase.state === 'disposed' ||
      phase.state === 'starting' ||
      phase.state === 'settling'
    )
      return
    cancel()
    try {
      ports.completion.clear()
    } catch (error) {
      ports.onError(error)
    }
    start()
  }

  function dispose() {
    if (phase.state === 'disposed') return scope.dispose()
    const next = phase.commands.dispose()
    if (next.kind === 'advanced') phase = next.phase
    pending = undefined
    presentation = undefined
    const cleanup = scope.dispose()
    notify()
    return cleanup
  }

  return { snapshot, start, reset, scheduleAutomaticStart, dispose }
}
