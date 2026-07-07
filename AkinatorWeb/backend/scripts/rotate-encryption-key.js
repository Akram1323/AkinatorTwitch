/**
 * Rotation de la clé de chiffrement des IP (RGPD).
 * Re-chiffre users.ip_address et sessions.ip_address avec la nouvelle clé.
 *
 * Usage :
 *   OLD_ENCRYPTION_KEY=<ancienne hex64> ENCRYPTION_KEY=<nouvelle hex64> node scripts/rotate-encryption-key.js
 */
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const oldHex = process.env.OLD_ENCRYPTION_KEY;
const newHex = process.env.ENCRYPTION_KEY;
if (!/^[0-9a-fA-F]{64}$/.test(oldHex || '') || !/^[0-9a-fA-F]{64}$/.test(newHex || '')) {
    console.error('❌ OLD_ENCRYPTION_KEY et ENCRYPTION_KEY (64 hex) sont requises.');
    process.exit(1);
}
const oldKey = Buffer.from(oldHex, 'hex');
const newKey = Buffer.from(newHex, 'hex');

const Database = require('better-sqlite3');
const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, '../data/akinator.db'));

function decrypt(payload, key) {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(decoded.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(decoded.tag, 'base64'));
    return decipher.update(decoded.encrypted, 'base64', 'utf8') + decipher.final('utf8');
}

function encrypt(text, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
    return Buffer.from(JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        encrypted
    })).toString('base64');
}

let rotated = 0, skipped = 0;
for (const { table, column } of [
    { table: 'users', column: 'ip_address' },
    { table: 'sessions', column: 'ip_address' }
]) {
    const rows = db.prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
    for (const row of rows) {
        try {
            const clear = decrypt(row.value, oldKey);
            db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(encrypt(clear, newKey), row.id);
            rotated++;
        } catch (e) {
            skipped++; // donnée illisible avec l'ancienne clé (ancien format) : laissée telle quelle
        }
    }
}
console.log(`✅ Rotation terminée : ${rotated} valeur(s) re-chiffrée(s), ${skipped} ignorée(s).`);
