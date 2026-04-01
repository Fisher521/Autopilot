/**
 * 文件锁 — 多 executor 并发时防止写冲突
 *
 * P2-6: CC 用 file lock + 30 次重试（5ms-100ms）防并发写冲突。
 * autopilot 多任务并行时，共享资源（results.tsv、task 状态文件）需要锁。
 *
 * 实现：简单的内存锁 + 超时重试。
 * 不用 OS 级 flock，因为 autopilot 是单进程多协程模型。
 * 如果以后变多进程，换成 proper-lockfile 或 flock。
 */

// ============================================================
// Types
// ============================================================

export interface LockOptions {
  /** 最大重试次数（默认 30，和 CC 一样） */
  retries: number
  /** 最小等待时间 ms（默认 5） */
  minTimeout: number
  /** 最大等待时间 ms（默认 100） */
  maxTimeout: number
  /** 锁持有的最大时间 ms，防止死锁（默认 10000） */
  staleTimeout: number
}

export interface LockInfo {
  holder: string        // 谁持有锁
  acquiredAt: number    // 获取时间（Date.now()）
  resource: string      // 锁的资源名
}

// ============================================================
// Default options（和 CC 一样）
// ============================================================

const DEFAULT_OPTIONS: LockOptions = {
  retries: 30,
  minTimeout: 5,
  maxTimeout: 100,
  staleTimeout: 10000,
}

// ============================================================
// Lock Store — 内存级别的锁
// ============================================================

const locks = new Map<string, LockInfo>()

/**
 * 获取锁 — 带重试
 *
 * @param resource 资源名（如 "results.tsv" 或 "task-123"）
 * @param holder 持有者 ID（如 "executor-1"）
 * @param options 锁选项
 * @returns 是否成功获取
 */
export async function acquireLock(
  resource: string,
  holder: string,
  options?: Partial<LockOptions>,
): Promise<boolean> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    // 检查是否已锁
    const existing = locks.get(resource)

    if (existing) {
      // 检查是否过期（死锁保护）
      const elapsed = Date.now() - existing.acquiredAt
      if (elapsed > opts.staleTimeout) {
        // 过期了，强制释放
        locks.delete(resource)
        // fall through to acquire
      } else if (existing.holder === holder) {
        // 同一个 holder 重入 → 允许
        return true
      } else {
        // 被别人持有，等一下再试
        if (attempt < opts.retries) {
          const delay = randomBetween(opts.minTimeout, opts.maxTimeout)
          await sleep(delay)
          continue
        }
        return false  // 重试次数用完
      }
    }

    // 获取锁
    locks.set(resource, {
      holder,
      acquiredAt: Date.now(),
      resource,
    })
    return true
  }

  return false
}

/**
 * 释放锁
 *
 * 只有持有者本人或强制释放才能解锁。
 */
export function releaseLock(resource: string, holder: string): boolean {
  const existing = locks.get(resource)
  if (!existing) return true  // 已经没有锁了

  if (existing.holder !== holder) {
    return false  // 不是你的锁
  }

  locks.delete(resource)
  return true
}

/**
 * 强制释放锁（council/human 用）
 */
export function forceReleaseLock(resource: string): void {
  locks.delete(resource)
}

/**
 * 查看锁状态
 */
export function getLockInfo(resource: string): LockInfo | undefined {
  return locks.get(resource)
}

/**
 * 获取所有活跃的锁
 */
export function getAllLocks(): LockInfo[] {
  return [...locks.values()]
}

/**
 * 用 lock 保护一段操作 — withLock pattern
 *
 * 自动 acquire → 执行 → release，即使出错也 release。
 *
 * @example
 * await withLock('results.tsv', 'executor-1', async () => {
 *   // 安全写 results.tsv
 * })
 */
export async function withLock<T>(
  resource: string,
  holder: string,
  fn: () => Promise<T>,
  options?: Partial<LockOptions>,
): Promise<T> {
  const acquired = await acquireLock(resource, holder, options)
  if (!acquired) {
    throw new Error(
      `LOCK FAILED: Could not acquire lock on "${resource}" after ${(options?.retries ?? DEFAULT_OPTIONS.retries)} retries. ` +
      `Currently held by: ${locks.get(resource)?.holder ?? 'unknown'}`
    )
  }

  try {
    return await fn()
  } finally {
    releaseLock(resource, holder)
  }
}

/**
 * 清空所有锁（测试用）
 */
export function _resetLocks(): void {
  locks.clear()
}

// ============================================================
// Helpers
// ============================================================

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
