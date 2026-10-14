// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { CAD_PART_KEY, isModelMesh, loadCADModel } from './cad-model/load-model'
import { MATERIAL_PRESETS } from './CADViewerTypes'
import type { CADModelStats } from './cad-model/load-model'
import type { MaterialPreset } from './CADViewerTypes'
import type { ThreeEvent } from '@react-three/fiber'
import { useOwnedResource } from '@/lifecycle/useOwnedResource'
import { useOwnedEffect } from '@/lifecycle/useOwnedEffect'

export type { CADModelStats } from './cad-model/load-model'

/**
 * The geometry half of the CAD viewer: loading a file, dressing it in the
 * chosen material, and — for a structured assembly — letting the pointer
 * reach the individual parts inside it.
 *
 * Split out of `CADViewer` when picking arrived. The two halves never shared
 * state: everything above is a scene (camera, lights, controls, framing) and
 * everything here is a model, and they meet at the bounding box the loader
 * reports. Format parsing and resource acquisition live in the load adapter.
 */

/** Emissive tints for the two highlight states, and how hard to drive them. */
const HIGHLIGHT = {
  selected: { color: 0x2563eb, intensity: 0.9 },
  hovered: { color: 0x1d4ed8, intensity: 0.35 },
} as const

/** The part a pointer event landed on, or null if it landed on a flat model. */
function pickedNodeKey(event: ThreeEvent<PointerEvent | MouseEvent>): string {
  const key: unknown = event.object.userData[CAD_PART_KEY]
  return typeof key === 'string' ? key : ''
}

/** Every material on a mesh, whether it carries one or an array of them. */
function materialsOf(mesh: THREE.Mesh): Array<THREE.Material> {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

/**
 * Loads and displays the 3D geometry. STL, OBJ and glTF/GLB.
 *
 * For glTF files with embedded colors, supports switching between original
 * materials and preset overrides.
 *
 * A `tint` replaces every material with a flat translucent color — the
 * comparison overlay's rendering mode. Translucent tints skip depth writes
 * so two near-coincident shells blend instead of z-fighting; unchanged
 * regions read as the blend of both colors, differences as a single color.
 */
export function CADModel({
  fileUrl,
  fileType,
  wireframe = false,
  materialPreset = 'default',
  hasEmbeddedColors = false,
  tint = null,
  visible = true,
  renderOrder = 0,
  selectedNodeKey = null,
  hoveredNodeKey = null,
  onNodePointerMove,
  onNodePointerOut,
  onNodeClick,
  onNodeContextMenu,
  onLoad,
  onError,
}: {
  fileUrl: string
  fileType: string
  wireframe?: boolean
  materialPreset?: MaterialPreset
  hasEmbeddedColors?: boolean
  tint?: { color: string; opacity: number } | null
  visible?: boolean
  renderOrder?: number
  /** Part drawn as selected, by node key. */
  selectedNodeKey?: string | null
  /** Part drawn as hovered, by node key. */
  hoveredNodeKey?: string | null
  /**
   * Pointer handlers, by node key. Supplying any of them is what makes the
   * model interactive: R3F only raycasts against objects that have handlers,
   * so a viewer with nothing to select pays nothing per frame.
   */
  onNodePointerMove?: (nodeKey: string) => void
  onNodePointerOut?: () => void
  onNodeClick?: (nodeKey: string) => void
  onNodeContextMenu?: (nodeKey: string) => void
  onLoad: (stats: CADModelStats) => void
  onError: (error: Error) => void
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)
  const input = useMemo(() => ({ fileUrl, fileType }), [fileUrl, fileType])
  const model = useOwnedResource(input, loadCADModel, {
    ready: (loaded) => onLoad(loaded.stats),
    failed: (error) =>
      onError(error instanceof Error ? error : new Error(String(error))),
  })
  const geometry = model.kind === 'ready' ? model.value.geometry : null
  const gltfScene = model.kind === 'ready' ? model.value.gltfScene : null
  const originalMaterials =
    model.kind === 'ready' ? model.value.originalMaterials : null
  // Apply material overrides to glTF scene when tint, preset, or wireframe changes
  const tintColor = tint?.color
  const tintOpacity = tint?.opacity
  const materialInput = useMemo(
    () =>
      gltfScene && originalMaterials
        ? {
            gltfScene,
            originalMaterials,
            tintColor,
            tintOpacity,
            hasEmbeddedColors,
            materialPreset,
            wireframe,
            renderOrder,
          }
        : null,
    [
      gltfScene,
      originalMaterials,
      tintColor,
      tintOpacity,
      hasEmbeddedColors,
      materialPreset,
      wireframe,
      renderOrder,
    ],
  )
  useOwnedEffect(
    materialInput,
    (config, lifetime) => {
      const ownMaterial = (create: () => THREE.Material) =>
        lifetime.acquire(create, (material) => material.dispose())
      const tinted =
        config.tintColor !== undefined && config.tintOpacity !== undefined
      const overlayOpacity = config.tintOpacity ?? 1
      const useOriginal =
        !tinted &&
        config.hasEmbeddedColors &&
        config.materialPreset === 'default' &&
        !config.wireframe
      // Translucent comparison shells stay out of the shadow pass.
      const castsShadow = !tinted || overlayOpacity >= 0.99
      config.gltfScene.traverse((child) => {
        if (!isModelMesh(child)) return
        const previousMaterial = child.material
        child.renderOrder = config.renderOrder
        // Three.js mesh flags do not inherit from the primitive group.
        child.castShadow = castsShadow
        child.receiveShadow = true
        if (tinted) {
          child.material = ownMaterial(
            () =>
              new THREE.MeshStandardMaterial({
                color: config.tintColor,
                metalness: 0.15,
                roughness: 0.6,
                transparent: true,
                opacity: overlayOpacity,
                depthWrite: overlayOpacity >= 0.99,
                wireframe: config.wireframe,
              }),
          )
        } else if (useOriginal) {
          const original = config.originalMaterials.get(child.uuid)
          if (original)
            child.material = Array.isArray(original)
              ? original.map((material) => ownMaterial(() => material.clone()))
              : ownMaterial(() => original.clone())
        } else {
          const preset = MATERIAL_PRESETS[config.materialPreset]
          child.material = ownMaterial(
            () =>
              new THREE.MeshStandardMaterial({
                color: config.wireframe ? '#3b82f6' : preset.color,
                metalness: config.wireframe ? 0.1 : preset.metalness,
                roughness: config.wireframe ? 0.8 : preset.roughness,
                wireframe: config.wireframe,
              }),
          )
        }
        lifetime.onDispose(() => {
          child.material = previousMaterial
        })
      })
    },
    model.kind === 'ready' ? model.value.lifetime : undefined,
  )
  // Light the selected and hovered parts.
  //
  // Deliberately a second pass that mutates `emissive` rather than a branch
  // inside the material effect above: that effect builds a new material per
  // mesh, so folding hover into it would rebuild every material in an
  // eighty-part assembly on each pointer move. It does have to re-run whenever
  // that effect does, though — a rebuilt material arrives with the highlight
  // gone — hence the shared dependencies, and the ordering that puts this
  // effect second in the same commit.
  useEffect(() => {
    if (!gltfScene) return
    if (selectedNodeKey === null && hoveredNodeKey === null) return

    const restore: Array<() => void> = []

    gltfScene.traverse((child) => {
      if (!isModelMesh(child)) return

      const key: unknown = child.userData[CAD_PART_KEY]
      const tone =
        key === selectedNodeKey
          ? HIGHLIGHT.selected
          : key === hoveredNodeKey
            ? HIGHLIGHT.hovered
            : null
      if (!tone) return

      for (const material of materialsOf(child)) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue

        const previousColor = material.emissive.getHex()
        const previousIntensity = material.emissiveIntensity
        restore.push(() => {
          material.emissive.setHex(previousColor)
          material.emissiveIntensity = previousIntensity
        })

        material.emissive.setHex(tone.color)
        material.emissiveIntensity = tone.intensity
      }
    })

    return () => {
      for (const undo of restore) undo()
    }
  }, [
    gltfScene,
    selectedNodeKey,
    hoveredNodeKey,
    // Everything the material effect above rebuilds materials for, so the
    // highlight is re-applied on top of the new ones rather than lost.
    materialPreset,
    wireframe,
    hasEmbeddedColors,
    tintColor,
    tintOpacity,
  ])

  const mat = MATERIAL_PRESETS[materialPreset]
  // Translucent tints don't write depth or cast shadows — overlapping
  // version shells must blend rather than occlude or double-shadow
  const tintIsSolid = !tint || tint.opacity >= 0.99

  // Render glTF scene
  if (gltfScene) {
    // R3F reports every object under the ray, nearest first, and calls the
    // handler once for each. Stopping propagation on the first is what makes
    // a click select the part in front rather than also the three behind it.
    const handle =
      (report: ((nodeKey: string) => void) | undefined) =>
      (event: ThreeEvent<PointerEvent | MouseEvent>) => {
        if (!report) return
        const key = pickedNodeKey(event)
        if (!key) return
        event.stopPropagation()
        report(key)
      }

    return (
      // Shadow flags are set per-mesh in the traversal above, not here: a
      // group does not pass them to its children.
      <primitive
        ref={groupRef}
        object={gltfScene}
        visible={visible}
        onPointerMove={
          onNodePointerMove ? handle(onNodePointerMove) : undefined
        }
        onPointerOut={onNodePointerOut ? () => onNodePointerOut() : undefined}
        onClick={onNodeClick ? handle(onNodeClick) : undefined}
        onContextMenu={
          onNodeContextMenu ? handle(onNodeContextMenu) : undefined
        }
      />
    )
  }

  // Render STL/OBJ geometry
  if (!geometry) {
    return null
  }

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      visible={visible}
      renderOrder={renderOrder}
      castShadow={tintIsSolid}
      receiveShadow
    >
      <meshStandardMaterial
        color={tint ? tint.color : wireframe ? '#3b82f6' : mat.color}
        metalness={tint ? 0.15 : wireframe ? 0.1 : mat.metalness}
        roughness={tint ? 0.6 : wireframe ? 0.8 : mat.roughness}
        flatShading={false}
        wireframe={wireframe}
        transparent={Boolean(tint)}
        opacity={tint?.opacity ?? 1}
        depthWrite={tintIsSolid}
      />
    </mesh>
  )
}
