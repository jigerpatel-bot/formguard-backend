/**
 * AES-256-GCM encryption for sensitive fields (SSN, DOB, etc.)
 * Each encrypt call generates a unique IV — same plaintext ≠ same ciphertext.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX = process.env.ENCRYPTION_KEY;

if (!KEY_HEX || KEY_HEX.length < 32) {
  console.warn('⚠️  ENCRYPTION_KEY not set or too short. Sensitive fields will NOT be encrypted in dev mode.');
}

const getKey = () => {
  if (!KEY_HEX) return crypto.randomBytes(32); // dev fallback (data won't be recoverable across restarts)
  return Buffer.from(KEY_HEX.padEnd(64, '0').slice(0, 64), 'hex');
};

/**
 * Encrypt a string. Returns a base64 string: iv:authTag:ciphertext
 */
const encrypt = (plaintext) => {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map(b => b.toString('base64')).join(':');
};

/**
 * Decrypt a base64 string produced by encrypt().
 */
const decrypt = (ciphertext) => {
  if (!ciphertext) return null;
  try {
    const [ivB64, authTagB64, dataB64] = ciphertext.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null; // tampered or wrong key
  }
};

/**
 * Mask SSN for display: XXX-XX-1234
 */
const maskSSN = (ssn) => {
  if (!ssn) return null;
  const digits = ssn.replace(/\D/g, '');
  return `XXX-XX-${digits.slice(-4)}`;
};

module.exports = { encrypt, decrypt, maskSSN };
