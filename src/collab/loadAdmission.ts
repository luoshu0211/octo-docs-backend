import { getHeapStatistics } from 'node:v8'
import { CapacityBusyError, CapacityLane } from './capacityLane.js'

interface MemoryReading { heapUsed: number; heapLimit: number; available: number; capacity: number }
function memoryReading(): MemoryReading {
  return { heapUsed: process.memoryUsage().heapUsed, heapLimit: getHeapStatistics().heap_size_limit,
    // Node 22/libuv accounts for the process's cgroup on Linux, including helpers.
    available: process.availableMemory(), capacity: process.constrainedMemory() }
}

/**
 * Shed NEW room loads under pressure; never evict a room with uncommitted edits.
 * This watermark is not proof that one unusually costly document will fit.
 * Keep per-document caps, and qualify higher caps with real peak measurements.
 */
export class LoadAdmission {
  private readonly lane = new CapacityLane(32)
  constructor(private readonly readMemory: () => MemoryReading = memoryReading) {}

  assertHeadroom(): void {
    const memory = this.readMemory()
    // On unconstrained hosts availableMemory can mean only currently free OS
    // pages (not reclaimable cache). Do not compare that with physical RAM and
    // reject every load on an otherwise healthy developer/standalone machine.
    // Reserve half a small pod, or >=1 GiB / 25% on larger ones, for the helper,
    // IPC/codec buffers and one in-flight load. In a 2 GiB numeric-sheet test a
    // 768 MiB reserve still reached 94% cgroup usage after the last admitted load.
    const reserved = Math.min(memory.capacity * 0.5, Math.max(memory.capacity * 0.25, 1024 ** 3))
    if (memory.heapUsed > memory.heapLimit * 0.8 || (memory.capacity > 0 && memory.available < reserved)) {
      throw new CapacityBusyError('node memory headroom is low')
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.lane.run(async () => { this.assertHeadroom(); return operation() })
  }
}

export const loadAdmission = new LoadAdmission()
