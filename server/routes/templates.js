const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { KarixClient, KarixApiError } = require('../services/karixClient');
const { validateTemplate, canEdit } = require('../services/templateValidator');
const { decryptToken } = require('../services/crypto');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

/**
 * Resolves a KarixClient for a given waba_account row, scoped to the
 * requester's organization. `req.auth` is expected to be populated by your
 * auth middleware (not included in this scaffold) with { organizationId, userId, role }.
 */
async function getKarixClientForWaba(wabaAccountId, organizationId) {
  const { rows } = await pool.query(
    `SELECT * FROM waba_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true`,
    [wabaAccountId, organizationId]
  );
  if (!rows.length) throw new Error('WABA account not found for this organization');
  const waba = rows[0];
  const token = decryptToken(waba.karix_token_enc);
  return { client: new KarixClient({ token, wabaId: waba.waba_id, region: waba.region }), waba };
}

// ---- List templates the platform knows about (from our DB, fast) --------
router.get('/', asyncHandler(async (req, res) => {
  const { organizationId } = req.auth;
  const { rows } = await pool.query(
    `SELECT id, template_name, category, language, status, karix_template_id, created_at, updated_at
     FROM templates WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [organizationId]
  );
  res.json({ templates: rows });
}));

// ---- Submit a validated spec (from chat or bulk import) to Karix --------
router.post('/submit', asyncHandler(async (req, res) => {
  const { organizationId, userId } = req.auth;
  const { wabaAccountId, spec, source = 'chat' } = req.body;

  if (!organizationId || !wabaAccountId || !spec) {
    return res.status(400).json({ error: 'organizationId (via auth), wabaAccountId, and spec are all required' });
  }

  const { valid, errors, warnings } = validateTemplate(spec);
  if (!valid) return res.status(422).json({ error: 'validation_failed', errors, warnings });

  let client;
  try {
    ({ client } = await getKarixClientForWaba(wabaAccountId, organizationId));
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }

  let templateRowId;
  try {
    const insert = await pool.query(
      `INSERT INTO templates (organization_id, waba_account_id, created_by, source, template_name, category, language, spec_json, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_review') RETURNING id`,
      [organizationId, wabaAccountId, userId || null, source, spec.template_name, spec.category, spec.language, spec]
    );
    templateRowId = insert.rows[0].id;
  } catch (err) {
    console.error('templates insert failed', err);
    return res.status(500).json({ error: 'db_insert_failed', detail: err.message });
  }

  try {
    const { body } = await client.createTemplate(spec);
    await pool.query(
      `UPDATE templates SET status='submitted', karix_response=$1, karix_template_id=$2, updated_at=now() WHERE id=$3`,
      [body, body && (body.id || body.template_id || body.templateId) || null, templateRowId]
    );
    return res.json({ templateRowId, karixResponse: body, warnings });
  } catch (err) {
    const detail = err instanceof KarixApiError ? { status: err.status, body: err.body } : { message: err.message };
    await pool.query(
      `UPDATE templates SET status='failed', karix_response=$1, updated_at=now() WHERE id=$2`,
      [detail, templateRowId]
    );
    return res.status(502).json({ error: 'karix_submit_failed', detail });
  }
}));

// ---- Refresh status for one template from Karix --------------------------
router.get('/:id/refresh', asyncHandler(async (req, res) => {
  const { organizationId } = req.auth;
  const { rows } = await pool.query(`SELECT * FROM templates WHERE id=$1 AND organization_id=$2`, [req.params.id, organizationId]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const row = rows[0];
  if (!row.karix_template_id) return res.status(400).json({ error: 'not_submitted_yet' });

  const { client } = await getKarixClientForWaba(row.waba_account_id, organizationId);
  const { body } = await client.getTemplate(row.karix_template_id);
  // NOTE: map Karix's actual status field name once confirmed against a live response.
  res.json({ karixResponse: body });
}));

// ---- Delete ---------------------------------------------------------------
router.delete('/:id', asyncHandler(async (req, res) => {
  const { organizationId } = req.auth;
  const { rows } = await pool.query(`SELECT * FROM templates WHERE id=$1 AND organization_id=$2`, [req.params.id, organizationId]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const row = rows[0];

  if (row.karix_template_id) {
    const { client } = await getKarixClientForWaba(row.waba_account_id, organizationId);
    await client.deleteTemplate(row.karix_template_id);
  }
  await pool.query(`UPDATE templates SET status='deleted', updated_at=now() WHERE id=$1`, [row.id]);
  res.json({ ok: true });
}));

// ---- Media upload for HEADER (image/video/document) before create/edit --
router.post('/media/:wabaAccountId', upload.single('file'), asyncHandler(async (req, res) => {
  const { organizationId } = req.auth;
  const { fileType: category } = req.body; // 'image' | 'video' | 'document' — classification only; the real MIME type (req.file.mimetype) is what's actually sent to Karix
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  try {
    const { client } = await getKarixClientForWaba(req.params.wabaAccountId, organizationId);
    const { body } = await client.uploadMedia({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      category,
    });
    res.json({ karixResponse: body }); // confirmed shape: { response: { fileHandle: "4::..." } }
  } catch (err) {
    const detail = err instanceof KarixApiError ? { status: err.status, body: err.body } : { message: err.message };
    res.status(502).json({ error: 'media_upload_failed', detail });
  }
}));

module.exports = router;
