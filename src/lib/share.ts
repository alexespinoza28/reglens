// Doctor and Write inputs ride in the URL hash as base64url JSON, so a link
// reproduces the exact view: #doctor/stm32f411/<payload>

export function encodePayload(o: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePayload<T>(s: string | undefined): Partial<T> {
  if (!s) return {};
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const o: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return o && typeof o === 'object' ? (o as Partial<T>) : {};
  } catch {
    return {};
  }
}
