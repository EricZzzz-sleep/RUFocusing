/** Preserve Supabase's cross-tab locking without rejecting a Web Locks callback.
 * Firefox can report callback rejections as page errors even when the request
 * promise is caught. Propagate failures only after the native lock is released.
 */
export async function browserAuthLock<T>(name: string, timeout: number, action: () => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined
  const unavailable = () => Object.assign(new Error('Authentication is busy in another tab. Please retry.'), { isAcquireTimeout: true })
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown }
  try {
    const outcome = await navigator.locks.request(name,
      timeout === 0 ? { mode: 'exclusive', ifAvailable: true } : { mode: 'exclusive', signal: controller.signal },
      async (lock): Promise<Outcome> => {
        clearTimeout(timer)
        if (!lock) return { ok: false, error: unavailable() }
        try { return { ok: true, value: await action() } }
        catch (error) { return { ok: false, error } }
      })
    if (!outcome.ok) throw outcome.error
    return outcome.value
  } catch (error) {
    if (controller.signal.aborted) throw unavailable()
    throw error
  } finally { clearTimeout(timer) }
}
