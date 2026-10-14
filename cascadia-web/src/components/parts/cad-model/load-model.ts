// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { ResourceLifetime } from '@cascadia/commons/managed-resources'

/** The converter's node identity, projected onto each descendant mesh for picking. */
export const CAD_PART_KEY = 'cascadiaPartKey'
const CONVERTER_NODE_KEY = 'cascadiaNodeKey'

export interface CADModelStats {
  polygonCount: number
  boundingBox: THREE.Vector3
  /** Native part coordinates, used by the camera without recentering geometry. */
  boundingBoxCenter: THREE.Vector3
  /** Zero for flat models; structured assemblies expose selectable part nodes. */
  partNodeCount: number
}

export interface LoadedCADModel {
  lifetime: ResourceLifetime
  geometry: THREE.BufferGeometry | null
  gltfScene: THREE.Group | null
  originalMaterials: Map<string, THREE.Material | Array<THREE.Material>>
  stats: CADModelStats
}

/** Format parsing is domain-owned; every allocation belongs to the supplied lifetime. */
export async function loadCADModel(
  { fileUrl, fileType }: { fileUrl: string; fileType: string },
  lifetime: ResourceLifetime,
): Promise<LoadedCADModel> {
  const ext = fileType.toLowerCase()
  const originalMaterials = new Map<
    string,
    THREE.Material | Array<THREE.Material>
  >()
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await lifetime.acquire(
      () => new GLTFLoader().loadAsync(fileUrl),
      (loaded) => disposeScene(loaded.scene),
    )
    const scene = gltf.scene
    let polygonCount = 0
    let partNodeCount = 0
    const box = new THREE.Box3()
    scene.traverse((node) => {
      // The converter's extras tag is inherited by each mesh for O(1) picking.
      const key: unknown = node.userData[CONVERTER_NODE_KEY]
      if (typeof key === 'string' && key !== '') {
        partNodeCount++
        node.traverse((child) => {
          child.userData[CAD_PART_KEY] = key
        })
      }
      if (!isModelMesh(node)) return
      const clone = (material: THREE.Material) =>
        lifetime.acquire(
          () => material.clone(),
          (copy) => copy.dispose(),
        )
      originalMaterials.set(
        node.uuid,
        Array.isArray(node.material)
          ? node.material.map(clone)
          : clone(node.material),
      )
      polygonCount += trianglesIn(node.geometry)
      box.expandByObject(node)
    })
    return {
      lifetime,
      geometry: null,
      gltfScene: scene,
      originalMaterials,
      stats: statsFor(box, polygonCount, partNodeCount),
    }
  }

  let geometry: THREE.BufferGeometry
  if (ext === 'stl') {
    geometry = await lifetime.acquire(
      () => new STLLoader().loadAsync(fileUrl),
      (loaded) => loaded.dispose(),
    )
  } else if (ext === 'obj') {
    const object = await lifetime.acquire(
      () => new OBJLoader().loadAsync(fileUrl),
      disposeScene,
    )
    const meshes: Array<THREE.BufferGeometry> = []
    object.traverse((child) => {
      if (isModelMesh(child)) meshes.push(child.geometry)
    })
    const first = meshes[0]
    if (!first) throw new Error('No geometry found in OBJ file')
    geometry = first
  } else {
    throw new Error(`Unsupported file type: ${ext}`)
  }
  if (!('normal' in geometry.attributes)) geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return {
    lifetime,
    geometry,
    gltfScene: null,
    originalMaterials,
    stats: statsFor(
      geometry.boundingBox ?? new THREE.Box3(),
      trianglesIn(geometry),
      0,
    ),
  }
}

function trianglesIn(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : (geometry.attributes.position?.count ?? 0) / 3
}

function statsFor(
  box: THREE.Box3,
  polygons: number,
  partNodeCount: number,
): CADModelStats {
  return {
    polygonCount: Math.floor(polygons),
    boundingBox: box.getSize(new THREE.Vector3()),
    boundingBoxCenter: box.getCenter(new THREE.Vector3()),
    partNodeCount,
  }
}

function disposeScene(scene: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  scene.traverse((child) => {
    if (!isModelMesh(child)) return
    geometries.add(child.geometry)
    for (const material of Array.isArray(child.material)
      ? child.material
      : [child.material]) {
      materials.add(material)
      for (const value of Object.values(material)) {
        if (isModelTexture(value)) textures.add(value)
      }
    }
  })
  const errors: Array<unknown> = []
  for (const asset of [...geometries, ...materials, ...textures]) {
    try {
      asset.dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Model asset cleanup failed')
}

/** Vendor flags work across realms and independent Three.js module instances. */
export function isModelMesh(node: THREE.Object3D): node is THREE.Mesh {
  return 'isMesh' in node && node.isMesh === true
}

function isModelTexture(value: unknown): value is THREE.Texture {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isTexture' in value &&
    value.isTexture === true
  )
}
