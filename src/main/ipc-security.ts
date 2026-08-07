export function isTrustedRendererUrl(value: string, trusted: string): boolean {
  try { return Boolean(trusted) && new URL(value).href === new URL(trusted).href } catch { return false }
}
