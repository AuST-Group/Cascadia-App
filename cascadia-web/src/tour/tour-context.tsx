// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { tourSteps } from './tour-steps'
import type { Driver } from 'driver.js'
import type { ReactNode } from 'react'

const TOUR_STORAGE_KEY = 'cascadia-tour-completed'

interface TourContextValue {
  hasCompletedTour: boolean
  isTourActive: boolean
  startTour: () => void
  resetTour: () => void
  triggerFirstTimeTour: () => () => void
}

const TourContext = createContext<TourContextValue | null>(null)

export function TourProvider({
  children,
  enabled = true,
}: {
  children: ReactNode
  enabled?: boolean
}) {
  const [hasCompletedTour, setHasCompletedTour] = useState(true) // Default to true to prevent flash
  const [isTourActive, setIsTourActive] = useState(false)
  const driverRef = useRef<Driver | null>(null)
  const hasCheckedStorage = useRef(false)
  const pendingStart = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissingForNavigation = useRef(false)

  const cancelPendingStart = useCallback(() => {
    if (pendingStart.current !== null) {
      clearTimeout(pendingStart.current)
      pendingStart.current = null
    }
  }, [])

  const stopTour = useCallback(() => {
    cancelPendingStart()
    dismissingForNavigation.current = true
    driverRef.current?.destroy()
    dismissingForNavigation.current = false
  }, [cancelPendingStart])

  useEffect(() => {
    if (!enabled) stopTour()
    return stopTour
  }, [enabled, stopTour])

  // Check localStorage on mount (but don't auto-trigger - wait for login)
  useEffect(() => {
    if (hasCheckedStorage.current) return
    hasCheckedStorage.current = true

    const completed = localStorage.getItem(TOUR_STORAGE_KEY)
    const isCompleted = completed === 'true'
    setHasCompletedTour(isCompleted)
  }, [])

  const startTourInternal = useCallback(() => {
    cancelPendingStart()
    // The ref is synchronous; React state cannot guard two starts in one tick.
    if (!enabled || driverRef.current) return
    // Create a new driver instance each time
    const driverInstance = driver({
      showProgress: true,
      showButtons: ['next', 'previous', 'close'],
      steps: tourSteps,
      popoverClass: 'cascadia-tour-popover',
      overlayColor: 'rgba(0, 0, 0, 0.75)',
      stagePadding: 8,
      stageRadius: 8,
      animate: true,
      allowClose: true,
      doneBtnText: 'Get Started',
      nextBtnText: 'Next',
      prevBtnText: 'Previous',
      onDestroyStarted: () => {
        // Mark tour as completed when user finishes or closes
        if (!dismissingForNavigation.current) {
          localStorage.setItem(TOUR_STORAGE_KEY, 'true')
          setHasCompletedTour(true)
        }
        setIsTourActive(false)
        driverInstance.destroy()
      },
      onDestroyed: () => {
        setIsTourActive(false)
        if (driverRef.current === driverInstance) driverRef.current = null
      },
    })

    driverRef.current = driverInstance
    setIsTourActive(true)
    driverInstance.drive()
  }, [enabled, cancelPendingStart])

  const startTour = useCallback(() => {
    // If already active, don't start again
    if (driverRef.current) return

    startTourInternal()
  }, [startTourInternal])

  const resetTour = useCallback(() => {
    stopTour()
    // Clear completion state and restart
    localStorage.removeItem(TOUR_STORAGE_KEY)
    setHasCompletedTour(false)
    startTourInternal()
  }, [startTourInternal, stopTour])

  const triggerFirstTimeTour = useCallback(() => {
    // Skip tour in test mode (Playwright sets this via storageState)
    if (!enabled || localStorage.getItem('cascadia-e2e-test') === 'true')
      return cancelPendingStart

    // Only trigger if user hasn't completed the tour before
    const completed = localStorage.getItem(TOUR_STORAGE_KEY)
    if (
      completed === 'true' ||
      driverRef.current ||
      pendingStart.current !== null
    )
      return cancelPendingStart

    // Delay to allow the dashboard to render
    pendingStart.current = setTimeout(() => {
      pendingStart.current = null
      if (localStorage.getItem(TOUR_STORAGE_KEY) !== 'true') startTourInternal()
    }, 1000)
    return cancelPendingStart
  }, [enabled, startTourInternal, cancelPendingStart])

  return (
    <TourContext.Provider
      value={{
        hasCompletedTour,
        isTourActive,
        startTour,
        resetTour,
        triggerFirstTimeTour,
      }}
    >
      {children}
    </TourContext.Provider>
  )
}

export function useTour() {
  const context = useContext(TourContext)
  if (!context) {
    throw new Error('useTour must be used within a TourProvider')
  }
  return context
}
