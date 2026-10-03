const encoder = new TextEncoder();

/**
 * Constant-time string comparison. Both values are hashed first, so the
 * comparison takes the same time whatever their lengths, and only Web Crypto
 * is used (works in workerd and in Node tests). An empty expected value never
 * matches, so an unset secret cannot be satisfied by an empty header.
 */
export async function safeEqual(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0 && expected.length > 0;
}
