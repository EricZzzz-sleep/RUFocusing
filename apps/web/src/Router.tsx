import { useEffect, useState, type AnchorHTMLAttributes } from 'react'
export function navigate(path: string, replace = false) {
  if (!path.startsWith('/') || path.startsWith('//')) return
  history[replace ? 'replaceState' : 'pushState'](null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
export function usePath() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => { const listener = () => setPath(location.pathname); addEventListener('popstate', listener); return () => removeEventListener('popstate', listener) }, [])
  return path
}
export function Link({ href = '/', onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} href={href} onClick={event => { onClick?.(event); if (!event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(href) } }}/>
}
