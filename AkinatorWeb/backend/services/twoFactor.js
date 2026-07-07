/**
 * 2FA renforcée : codes de secours à usage unique.
 * Les codes sont des jetons aléatoires haute entropie → SHA-256 suffit
 * (pas besoin de bcrypt, aucun risque de brute-force hors ligne réaliste).
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const speakeasy = require('speakeasy');
const { db } = require('./database');

const BACKUP_CODES_COUNT = 8;
const TOTP_WINDOW = 1; // ±30 s de tolérance

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

function currentStep() {
    return Math.floor(Date.now() / 1000 / 30);
}

/**
 * Vérifie un code TOTP avec garde anti-rejeu :
 * le step consommé est mémorisé, tout code d'un step <= dernier utilisé est refusé.
 */
function verifyTotp(user, code) {
    const delta = speakeasy.totp.verifyDelta({
        secret: user.a2f_secret,
        encoding: 'base32',
        token: String(code || '').trim(),
        window: TOTP_WINDOW
    });
    if (!delta) return { ok: false, error: 'Code A2F incorrect' };

    const step = currentStep() + delta.delta;
    if (user.a2f_last_step !== null && user.a2f_last_step !== undefined
        && step <= user.a2f_last_step) {
        return { ok: false, error: 'Code A2F déjà utilisé, attendez le prochain code' };
    }
    db.prepare('UPDATE users SET a2f_last_step = ? WHERE id = ?').run(step, user.id);
    return { ok: true };
}

module.exports = { generateBackupCodes, consumeBackupCode, BACKUP_CODES_COUNT, verifyTotp };
