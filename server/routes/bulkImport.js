const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const OpenAI = require('openai');
const pool = require('../db/pool');
const { validateTemplate } = require('../services/templateValidator');
const { KarixClient, KarixApiError } = require('../services/karixClient');
const { decryptToken } = require('../services/crypto');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Bulk row normalization is high-volume and doesn't need frontier reasoning —
// the cheaper/faster tier keeps large sheets affordable. Bump to
// OPENAI_CHAT_MODEL's tier if you see too many needs_review flags.
const BULK_MODEL = process.env.OPENAI_BULK_MODEL || 'gpt-5.6-luna';

// Karix caps template creation at 100/hour per WABA. Space submissions out
// so a large sheet doesn't blow past that even for a single client.
const MIN_GAP_MS = Math.ceil(3_600_000 / 90); // stay under 100/hr with margin

// Expected (flexible) columns — the normalizer below tolerates missing/extra
// columns and free-text cells; it does NOT require the user to already know
// Karix's JSON shape.
// name | category | language | header_type | header_text | body_text |
// footer | button_1_type | button_1_value | button_2_type | button_2_value | variable_examples

const NORMALIZE_TOOL = {
  type: 'function',
  function: {
    name: 'normalize_row',
    description: 'Convert one spreadsheet row describing a WhatsApp template into a Karix-shaped template spec.',
    parameters: {
      type: 'object',
      properties: {
        template_name: { type: 'string' },
        language: { type: 'string' },
        category: { type: 'string', enum: ['AUTHENTICATION', 'UTILITY', 'MARKETING'] },
        components: { type: 'array', items: { type: 'object' } },
        needs_review: { type: 'boolean', description: 'true if the row was too ambiguous/incomplete to build confidently' },
        review_reason: { type: 'string' },
      },
      required: ['template_name', 'language', 'category', 'components'],
    },
  },
};

const NORMALIZE_SYSTEM_PROMPT = `You convert one row of a spreadsheet (arbitrary column names/order, free text)
into a single Karix RCM Template API request body, using the emit via the
normalize_row tool. Rules: category must be AUTHENTICATION, UTILITY, or
MARKETING. Body variables become {{1}}, {{2}}... in order of appearance and
MUST include an "example" block with plausible example values — invent
reasonable examples from context if the sheet doesn't give them, but set
needs_review=true so a human double-checks. AUTHENTICATION templates must
never have an IMAGE/VIDEO/DOCUMENT header. If the row is too vague to
proceed (e.g. no body text at all), set needs_review=true and explain why
in review_reason, and still emit your best-effort partial spec.

Two hard rules confirmed by real Meta API rejections (not documented in
Karix's own docs, but WhatsApp enforces them regardless):
1. A variable can NEVER be the first or last thing in the body text —
   real words must precede the first {{n}} and follow the last one. If the
   spreadsheet's body text would start/end with a variable, rephrase it
   (e.g. add a word like "Hi" at the start) rather than leaving it as-is.
2. Any URL button whose url contains a variable (e.g.
   "https://x.com/track/{{1}}") MUST include an example array with one
   resolved sample URL (e.g. ["https://x.com/track/12345"]) on that
   button object, the same way body variables need examples. Missing this
   causes an outright rejection at submission.

Do not set needs_review=true just to double-check something that's
already unambiguous in the row. A button with both a clear label (e.g.
"Shop Now") and a complete static url is DONE — don't flag it to "confirm
the intended destination" or similar; only flag a button if a required
field is genuinely missing (e.g. a URL button with no url at all) or the
row's intent is truly unclear. Reserve needs_review for real ambiguity or
invented content, not for restating that a field exists and is filled in.`;

async function normalizeRow(row) {
  const response = await openai.chat.completions.create({
    model: BULK_MODEL,
    reasoning_effort: 'none', // see note in chat.js — reasoning-tier models need this off to use function tools on chat.completions
    messages: [
      { role: 'system', content: NORMALIZE_SYSTEM_PROMPT },
      { role: 'user', content: `Spreadsheet row:\n${JSON.stringify(row, null, 2)}` },
    ],
    tools: [NORMALIZE_TOOL],
    tool_choice: { type: 'function', function: { name: 'normalize_row' } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) return null;
  let spec;
  try {
    spec = JSON.parse(toolCall.function.arguments);
  } catch {
    return null;
  }
  return backfillBodyExamples(spec, row);
}

/**
 * The AI is instructed to always include a BODY example block when the
 * body has {{n}} placeholders, but it doesn't do this 100% reliably (it's
 * one instruction among many in a single generation call). The
 * spreadsheet's own `variable_examples` column is a deterministic source
 * of truth for the same information, so use it directly instead of only
 * hoping the model remembered — this removes an entire class of
 * needs_review flags and rejected submissions for a purely mechanical gap.
 */
function backfillBodyExamples(spec, row) {
  if (!spec || !Array.isArray(spec.components)) return spec;
  const bodyComp = spec.components.find((c) => c.type === 'BODY');
  if (!bodyComp || !bodyComp.text) return spec;

  const hasPlaceholders = /{{\s*[\w]+\s*}}/.test(bodyComp.text);
  const hasExample = bodyComp.example && (bodyComp.example.body_text || bodyComp.example.body_text_named_params);
  if (!hasPlaceholders || hasExample) return spec;

  const rawExamples = row.variable_examples || row.variableExamples || row['variable examples'];
  if (!rawExamples) return spec;

  const values = String(rawExamples).split(',').map((v) => v.trim()).filter(Boolean);
  if (!values.length) return spec;

  bodyComp.example = { body_text: [values] };
  return spec;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Upload + kick off an async job ---------------------------------------
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  const { organizationId, userId } = req.auth;
  const { wabaAccountId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  if (!wabaAccountId) return res.status(400).json({ error: 'wabaAccountId is required' });

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) return res.status(400).json({ error: 'no_rows_found' });

  const jobInsert = await pool.query(
    `INSERT INTO bulk_import_jobs (organization_id, waba_account_id, uploaded_by, file_name, total_rows, status)
     VALUES ($1,$2,$3,$4,$5,'queued') RETURNING id`,
    [organizationId, wabaAccountId, userId || null, req.file.originalname, rows.length]
  );
  const jobId = jobInsert.rows[0].id;

  for (let i = 0; i < rows.length; i++) {
    await pool.query(
      `INSERT INTO bulk_import_rows (job_id, row_number, raw_row) VALUES ($1,$2,$3)`,
      [jobId, i + 1, rows[i]]
    );
  }

  // Respond immediately; process in the background. For production, move
  // this to a proper queue (BullMQ/Redis, which you've already used on
  // other projects) instead of an in-process loop.
  processJob(jobId, organizationId).catch((err) => console.error('bulk import job failed', jobId, err));

  res.json({ jobId, totalRows: rows.length, status: 'queued' });
}));

// ---- Job status polling -----------------------------------------------------
router.get('/:jobId', asyncHandler(async (req, res) => {
  const { organizationId } = req.auth;
  const { rows } = await pool.query(`SELECT * FROM bulk_import_jobs WHERE id=$1 AND organization_id=$2`, [req.params.jobId, organizationId]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const rowDetail = await pool.query(
    `SELECT row_number, status, error_message, resolved_spec FROM bulk_import_rows WHERE job_id=$1 ORDER BY row_number`,
    [req.params.jobId]
  );
  res.json({ job: rows[0], rows: rowDetail.rows });
}));

async function processJob(jobId, organizationId) {
  await pool.query(`UPDATE bulk_import_jobs SET status='running' WHERE id=$1`, [jobId]);

  const jobRes = await pool.query(`SELECT * FROM bulk_import_jobs WHERE id=$1`, [jobId]);
  const job = jobRes.rows[0];

  const wabaRes = await pool.query(`SELECT * FROM waba_accounts WHERE id=$1 AND organization_id=$2`, [job.waba_account_id, organizationId]);
  const waba = wabaRes.rows[0];
  const client = new KarixClient({ token: decryptToken(waba.karix_token_enc), wabaId: waba.waba_id, region: waba.region });

  const rowsRes = await pool.query(`SELECT * FROM bulk_import_rows WHERE job_id=$1 ORDER BY row_number`, [jobId]);
  let succeeded = 0;
  let failed = 0;

  for (const row of rowsRes.rows) {
    const startedAt = Date.now();
    let spec = null;
    try {
      spec = await normalizeRow(row.raw_row);
      if (!spec) throw new Error('AI normalization returned nothing');

      const { valid, errors } = validateTemplate(spec);
      if (!valid || spec.needs_review) {
        await pool.query(
          `UPDATE bulk_import_rows SET status='needs_review', resolved_spec=$1, error_message=$2 WHERE id=$3`,
          [spec, spec.review_reason || (errors || []).join('; '), row.id]
        );
        failed += 1;
      } else {
        const templateInsert = await pool.query(
          `INSERT INTO templates (organization_id, waba_account_id, source, template_name, category, language, spec_json, status)
           VALUES ($1,$2,'excel_bulk',$3,$4,$5,$6,'pending_review') RETURNING id`,
          [organizationId, job.waba_account_id, spec.template_name, spec.category, spec.language, spec]
        );
        const templateRowId = templateInsert.rows[0].id;

        const { body } = await client.createTemplate(spec);
        await pool.query(
          `UPDATE templates SET status='submitted', karix_response=$1, karix_template_id=$2, updated_at=now() WHERE id=$3`,
          [body, body && (body.id || body.template_id || body.templateId) || null, templateRowId]
        );
        await pool.query(
          `UPDATE bulk_import_rows SET status='submitted', resolved_spec=$1, template_id=$2 WHERE id=$3`,
          [spec, templateRowId, row.id]
        );
        succeeded += 1;
      }
    } catch (err) {
      const message = err instanceof KarixApiError ? `Karix ${err.status}: ${JSON.stringify(err.body)}` : err.message;
      // Always save whatever spec was generated (even null), so a Karix-level
      // rejection is fully debuggable afterward instead of leaving resolved_spec
      // blank — `spec` used to be scoped inside the try block and unreachable here.
      await pool.query(`UPDATE bulk_import_rows SET status='failed', resolved_spec=$1, error_message=$2 WHERE id=$3`, [spec, message, row.id]);
      failed += 1;
    }

    await pool.query(
      `UPDATE bulk_import_jobs SET processed_rows = processed_rows + 1, succeeded_rows=$1, failed_rows=$2 WHERE id=$3`,
      [succeeded, failed, jobId]
    );

    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_GAP_MS) await sleep(MIN_GAP_MS - elapsed);
  }

  await pool.query(
    `UPDATE bulk_import_jobs SET status=$1, finished_at=now() WHERE id=$2`,
    [failed > 0 ? 'completed_with_errors' : 'completed', jobId]
  );
}

module.exports = router;
