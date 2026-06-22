import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Verifies the Authorization: Bearer <token> header against APP_PASSWORD.
 * Returns true if authorized. Returns false AND sends a 401 response if not.
 *
 * If APP_PASSWORD is not set on the server, returns 500 to force the operator
 * to configure it. This is intentional — silently running open would defeat
 * the purpose of having a login.
 */
export function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    res.status(500).json({ error: 'APP_PASSWORD is not configured on the server' });
    return false;
  }
  const auth = (req.headers.authorization || '').trim();
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}
