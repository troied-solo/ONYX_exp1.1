import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: 'APP_PASSWORD is not configured on the server' });
  }

  const submitted = (req.body?.password || '').toString();
  if (!submitted) {
    return res.status(400).json({ error: 'password is required' });
  }

  // Constant-time-ish comparison to avoid trivial timing leaks
  if (!safeEqual(submitted, expected)) {
    // Brief delay to slow naive brute-force from the same client
    await new Promise(r => setTimeout(r, 350));
    return res.status(401).json({ error: 'invalid password' });
  }

  // For a single-user PoC, the password IS the bearer token.
  // (Equivalent to a long-lived session token; identical security model.)
  return res.status(200).json({ token: expected });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
