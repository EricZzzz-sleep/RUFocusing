import type { AppState } from './types'
export async function jsonRequest<T>(path: string, data?: object): Promise<T> {
  const response = await fetch(path, {
    method: data ? 'POST' : 'GET',
    headers: data ? { 'Content-Type': 'application/json', 'X-RUFocusing': '1' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The local service is unavailable. Start the app with make run.')
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.')
  return result
}

export const request = (path = '/api/state', data?: object): Promise<AppState> => jsonRequest<AppState>(path, data)
