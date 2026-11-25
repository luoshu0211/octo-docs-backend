/** Both Docs-to-Drive clients support a proxy path in the configured base URL. */
export function driveInternalUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/+$/, '') + path
  return url.href
}
