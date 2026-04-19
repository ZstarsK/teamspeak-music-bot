export function getBasePath(): string {
  const raw = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  return raw || '';
}

export function withBasePath(path: string): string {
  const base = getBasePath();
  if (!path.startsWith('/')) return `${base}/${path}`;
  return `${base}${path}`;
}

export function getWebSocketUrl(path = '/ws'): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${withBasePath(path)}`;
}
