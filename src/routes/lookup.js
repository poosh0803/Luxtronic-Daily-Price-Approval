import express from 'express';
import { lookupPrices } from '../lookup.js';
const router = express.Router();

// GET /api/lookup?q=ryzen 7 9800x3d&pages=2
export async function lookupHandler(req, res) {
  if (!String(req.query.q || '').trim()) {
    return res.status(400).json({ success: false, message: 'q is required' });
  }
  try {
    const verify = req.query.verify !== '0'; // verify=0 skips the direct Scorptec / PCCG page checks
    res.json({ success: true, ...(await lookupPrices(req.query.q, req.query.pages, { verify })) });
  } catch (error) {
    console.error('Lookup failed:', error.message);
    res.status(502).json({ success: false, message: `Price lookup failed: ${error.message}` });
  }
}

router.get('/', lookupHandler);

export default router;
