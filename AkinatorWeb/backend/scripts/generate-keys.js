/**
 * Génère des secrets frais pour .env / variables Render.
 * Usage : node scripts/generate-keys.js
 */
const crypto = require('crypto');

console.log('# À copier dans .env (ou variables d\'environnement Render) :');
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`);
console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(`AUDIT_HMAC_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(`IP_HASH_SALT=${crypto.randomBytes(16).toString('hex')}`);
