const express = require('express');
const { encryptToken } = require('../services/crypto');

const router = express.Router();

/**
 * POST /api/admin/encrypt-token
 * Header: x-admin-secret: <ADMIN_SETUP_SECRET>
 * Body:   { "token": "<real Karix bearer token>" }
 * Returns: { "encrypted": "<value to paste into waba_accounts.karix_token_enc>" }
 *
 * This exists so you can generate encrypted tokens from Postman instead of
 * needing shell/SSH access to the server (which Render only offers on paid
 * instances). You'll use this every time you onboard a new client's WABA
 * account, not just once — keep it, just keep ADMIN_SETUP_SECRET private.
 */
router.post('/encrypt-token', (req, res) => {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SETUP_SECRET || provided !== process.env.ADMIN_SETUP_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const encrypted = encryptToken(token);
    res.json({ encrypted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
