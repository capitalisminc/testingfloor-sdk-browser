import type { Properties, Vector } from './client.ts'

export type SignedAxis = 1 | 2 | 3 | -1 | -2 | -3
export interface CoordinateTransform {
  /** Output X/Y/Z select distinct signed native axes. Default: [1, 2, 3]. */
  axes?: readonly [SignedAxis, SignedAxis, SignedAxis]
  /** Positive uniform scale. Sampling thresholds retain their native units. */
  scale?: number
  /** Output offset; affects points, never directions or lengths. */
  offset?: Vector
}

type Point = [number, number, number]
const POINTS = ['player.position', 'camera.position', 'camera.focus', 'teleport.start.position', 'teleport.end.position']
const DIRECTIONS = ['camera.forward', 'camera.up']
const LENGTHS = ['movement.distance', 'movement.camera_distance', 'movement.ortho_width_delta', 'teleport.distance', 'camera.ortho_width']

export class CoordinateSpace {
  readonly active: boolean
  readonly axes: readonly [SignedAxis, SignedAxis, SignedAxis]
  readonly scale: number
  readonly offset: Point

  constructor (configuration?: CoordinateTransform) {
    this.active = configuration !== undefined
    this.axes = [...(configuration?.axes ?? [1, 2, 3])]
    this.scale = configuration?.scale ?? 1
    this.offset = [configuration?.offset?.x ?? 0, configuration?.offset?.y ?? 0, configuration?.offset?.z ?? 0]
    if (this.axes.length !== 3 || this.axes.some(axis => !Number.isInteger(axis) || Math.abs(axis) < 1 || Math.abs(axis) > 3) ||
        new Set(this.axes.map(Math.abs)).size !== 3 || !Number.isFinite(this.scale) || this.scale <= 0 || !this.offset.every(Number.isFinite)) {
      throw new RangeError('Coordinate transform requires three distinct signed axes, a positive finite scale and a finite offset.')
    }
  }

  point (value: Point): Point {
    return this.axes.map((axis, index) => Math.sign(axis) * value[Math.abs(axis) - 1] * this.scale + this.offset[index]) as Point
  }

  properties (values: Properties): void {
    if (!this.active) return
    for (const prefix of [...POINTS, ...DIRECTIONS]) {
      const entries = ['x', 'y', 'z'].map(axis => values[`${prefix}.${axis}`])
      if (!entries.some(value => value !== undefined) || !entries.every(value => value === undefined || typeof value === 'number' && Number.isFinite(value))) continue
      const native = entries.map(value => value ?? 0) as Point
      const output = DIRECTIONS.includes(prefix)
        ? this.axes.map(axis => Math.sign(axis) * native[Math.abs(axis) - 1])
        : this.point(native)
      for (let index = 0; index < 3; index++) values[`${prefix}.${['x', 'y', 'z'][index]}`] = output[index]
    }
    for (const key of LENGTHS) {
      if (typeof values[key] === 'number' && Number.isFinite(values[key])) values[key] *= this.scale
    }
    for (const axis of ['x', 'y', 'z']) delete values[`camera.euler.${axis}`]
  }
}
