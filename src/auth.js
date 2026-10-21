import crypto from 'crypto';

// Bearer-key guard for /api/agent/*. The approval UI has no login (LAN-only
// trust), but the endpoints a script can call to submit prices need a key.
// Fails closed: with no key configured, the agent API is disabled.
export function requireAgentKey(req, res, next) {
  const expected = process.env.AGENT_API_KEY;
  if (!expected || expected === 'change-me') {
    return res.status(503).json({ success: false, message: 'AGENT_API_KEY is not configured on the server' });
  }
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: 'Invalid or missing API key' });
  }
  next();
}
