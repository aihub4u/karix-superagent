const express = require('express');
const pool = require('../db/pool');
const { encryptToken } = require('../services/crypto');

const router = express.Router();

function checkAdminSecret(req, res) {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SETUP_SECRET || provided !== process.env.ADMIN_SETUP_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'org';
}

/**
 * POST /api/admin/encrypt-token
 * Header: x-admin-secret: <ADMIN_SETUP_SECRET>
 * Body:   { "token": "<real Karix bearer token>" }
 * Returns: { "encrypted": "..." }
 *
 * Kept for manual/Postman use. For the UI-driven setup flow, see
 * /quick-setup below, which does this plus the org/waba_account rows in one call.
 */
router.post('/encrypt-token', (req, res) => {
  if (!checkAdminSecret(req, res)) return;
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    res.json({ encrypted: encryptToken(token) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/quick-setup
 * Header: x-admin-secret: <ADMIN_SETUP_SECRET>
 * Body: {
 *   orgName: string,        e.g. "MDH Spices"
 *   wabaId: string,         real Karix WABA ID
 *   region: 'india'|'uae',
 *   token: string           real Karix bearer token (plaintext in transit —
 *                            this call should only ever be made over HTTPS,
 *                            which Render gives you by default)
 * }
 *
 * Upserts an organization (by slug derived from orgName) and a waba_account
 * (by organization_id + wabaId), encrypting the token before it touches the
 * database. Meant for the in-app "Setup" panel so testing/onboarding a new
 * client doesn't require the SQL editor or Postman.
 *
 * Returns: { organizationId, wabaAccountId, orgName, wabaId }
 */
router.post('/quick-setup', async (req, res) => {
  if (!checkAdminSecret(req, res)) return;
  const { orgName, wabaId, region, token } = req.body;

  if (!orgName || !wabaId || !token) {
    return res.status(400).json({ error: 'orgName, wabaId, and token are all required' });
  }
  const safeRegion = region === 'uae' ? 'uae' : 'india';
  const slug = slugify(orgName);

  try {
    const orgResult = await pool.query(
      `INSERT INTO organizations (name, slug)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgName, slug]
    );
    const organizationId = orgResult.rows[0].id;

    const encrypted = encryptToken(token);
    const wabaResult = await pool.query(
      `INSERT INTO waba_accounts (organization_id, waba_id, region, karix_token_enc, label, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (organization_id, waba_id)
       DO UPDATE SET karix_token_enc = EXCLUDED.karix_token_enc, region = EXCLUDED.region, is_active = true
       RETURNING id`,
      [organizationId, wabaId, safeRegion, encrypted, `${orgName} - ${safeRegion}`]
    );
    const wabaAccountId = wabaResult.rows[0].id;

    res.json({ organizationId, wabaAccountId, orgName, wabaId });
  } catch (err) {
    console.error('quick-setup failed', err);
    res.status(500).json({ error: 'quick_setup_failed', detail: err.message });
  }
});

module.exports = router;
