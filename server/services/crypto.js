/**
 * AES-256-GCM encrypt/decrypt for Karix bearer tokens stored in waba_accounts.karix_token_enc.
 * Set TOKEN_ENCRYPTION_KEY in env to a 32-byte hex string, e.g.:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const KEY = process.env.TOKEN_ENCRYPTION_KEY
  ? Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex')
  : null;

function encryptToken(plainText) {
  if (!KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptToken(encoded) {
  if (!KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

module.exports = { encryptToken, decryptToken };
