// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createOwnedLifetime } from '@cascadia/commons/managed-resources'
import { loadCADModel } from './load-model'

afterEach(() => vi.restoreAllMocks())

it('attempts every OBJ cleanup, including shared assets, even when late cleanup throws', async () => {
  const geometries = [new THREE.BoxGeometry(), new THREE.BoxGeometry()]
  const texture = new THREE.Texture()
  const material = new THREE.MeshStandardMaterial({ map: texture })
  const scene = new THREE.Group()
  scene.add(...geometries.map((geometry) => new THREE.Mesh(geometry, material)))
  const releaseGeometry = geometries.map((geometry) =>
    vi.spyOn(geometry, 'dispose'),
  )
  const releaseMaterial = vi.spyOn(material, 'dispose')
  const releaseTexture = vi.spyOn(texture, 'dispose')
  vi.spyOn(OBJLoader.prototype, 'loadAsync').mockResolvedValue(scene)
  releaseGeometry[0]!.mockImplementation(() => {
    throw new Error('geometry cleanup failed')
  })

  const diagnostic = vi.fn()
  const owner = createOwnedLifetime(diagnostic)
  const completion = owner.run((lifetime) =>
    loadCADModel({ fileUrl: 'model.obj', fileType: 'obj' }, lifetime),
  )
  await owner.dispose()
  expect(await completion).toEqual({ kind: 'expired' })
  releaseGeometry.forEach((release) => expect(release).toHaveBeenCalledOnce())
  expect(releaseMaterial).toHaveBeenCalledOnce()
  expect(releaseTexture).toHaveBeenCalledOnce()
  expect(diagnostic).toHaveBeenCalledWith(expect.any(AggregateError))
})
