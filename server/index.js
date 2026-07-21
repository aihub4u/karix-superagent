require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const chatRoutes = require('./routes/chat');
const templateRoutes = require('./routes/templates');
const bulkImportRoutes = require('./routes/bulkImport');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/**
 * Placeholder auth middleware — replace with real session/JWT auth.
 * Every route under /api/templates and /api/bulk-import expects
 * req.auth = { organizationId, userId, role }.
 *
 * For local testing you can set:
 *   DEV_ORG_ID / DEV_USER_ID in .env and this middleware will use them.
 */
app.use((req, res, next) => {
  req.auth = {
    organizationId: req.headers['x-org-id'] || process.env.DEV_ORG_ID,
    userId: req.headers['x-user-id'] || process.env.DEV_USER_ID,
    role: req.headers['x-role'] || 'member',
  };
  next();
});

app.use('/api', chatRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/bulk-import', bulkImportRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Static chat UI (no build step — deploys as-is on Render)
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`karix-superagent listening on :${PORT}`));
