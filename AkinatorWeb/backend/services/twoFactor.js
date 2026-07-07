/**
 * 2FA renforcée : codes de secours à usage unique.
 * Les codes sont des jetons aléatoires haute entropie → SHA-256 suffit
 * (pas besoin de bcrypt, aucun risque de brute-force hors ligne réaliste).
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./database');

const BACKUP_CODES_COUNT = 8;

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function generateBackupCodes(userId) {
    db.prepare('DELETE FROM a2f_backup_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO a2f_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
    const codes = [];
    for (let i = 0; i < BACKUP_CODES_COUNT; i++) {
        const code = crypto.randomBytes(5).toString('hex'); // 10 caractères
        codes.push(code);
        insert.run(uuidv4(), userId, sha256(code));
    }
    return codes;
}

function consumeBackupCode(userId, code) {
    const normalized = String(code || '').trim().toLowerCase();
    const row = db.prepare(`
        SELECT id FROM a2f_backup_codes
        WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
    `).get(userId, sha256(normalized));
    if (!row) return false;
    db.prepare(`UPDATE a2f_backup_codes SET used_at = datetime('now') WHERE id = ?`).run(row.id);
    return true;
}

module.exports = { generateBackupCodes, consumeBackupCode, BACKUP_CODES_COUNT };
