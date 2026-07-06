/**
 * Journal d'audit inviolable (tamper-evident).
 * Chaque entrée embarque hash_n = SHA256(payload_n || hash_n-1).
 * Toute modification/suppression a posteriori casse la chaîne,
 * détectable par verifyAuditChain() → non-répudiation / forensics.
 */
const crypto = require('crypto');
const { db } = require('./database');

function computeHash(eventType, userId, ipHash, detailsJson, createdAt, prevHash) {
    const payload = [eventType, userId || '', ipHash || '', detailsJson, createdAt].join('|');
    return crypto.createHash('sha256').update(payload + prevHash).digest('hex');
}

/**
 * Ajoute une entrée d'audit. Transaction : lecture du dernier hash
 * + insertion atomiques (pas de course sur prev_hash).
 */
const appendAudit = db.transaction((eventType, { userId = null, ipHash = null, details = {} } = {}) => {
    const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
    const prevHash = last ? last.hash : 'GENESIS';
    const createdAt = new Date().toISOString();
    const detailsJson = JSON.stringify(details);
    const hash = computeHash(eventType, userId, ipHash, detailsJson, createdAt, prevHash);

    db.prepare(`
        INSERT INTO audit_log (event_type, user_id, ip_hash, details, created_at, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventType, userId, ipHash, detailsJson, createdAt, prevHash, hash);
});

/** Revalide toute la chaîne. */
function verifyAuditChain() {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    let prevHash = 'GENESIS';
    for (const row of rows) {
        const expected = computeHash(
            row.event_type, row.user_id, row.ip_hash, row.details, row.created_at, prevHash
        );
        if (row.prev_hash !== prevHash || row.hash !== expected) {
            return { valid: false, brokenAt: row.id };
        }
        prevHash = row.hash;
    }
    return { valid: true, count: rows.length };
}

module.exports = { appendAudit, verifyAuditChain };
