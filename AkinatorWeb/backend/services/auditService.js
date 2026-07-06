/**
 * Journal d'audit tamper-evident à chaînage HMAC.
 * Chaque entrée embarque hash_n = HMAC-SHA256(clé, payload_n || hash_n-1),
 * la clé (AUDIT_HMAC_KEY) étant conservée HORS de la base. Un attaquant
 * disposant d'un accès en écriture à la DB mais pas de la clé ne peut donc
 * pas recalculer une chaîne valide après altération.
 * Garanties réelles : détecte toute altération partielle, insertion ou
 * suppression interne (verifyAuditChain). Limites : ne détecte PAS la
 * troncature de queue (suppression des dernières lignes) sans ancrage externe.
 */
const crypto = require('crypto');
const config = require('../config/config');
const { db } = require('./database');

/**
 * Charge AUDIT_HMAC_KEY depuis l'environnement.
 * - Production : obligatoire, 64 hex → sinon arrêt (le journal ne serait pas protégé).
 * - Dev/test : fallback dérivé de JWT_SECRET (avec avertissement), pour ne pas bloquer.
 */
function loadAuditKey() {
    const raw = process.env.AUDIT_HMAC_KEY;
    const isProd = process.env.NODE_ENV === 'production';
    if (raw) {
        if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
            console.error('❌ AUDIT_HMAC_KEY invalide : 64 caractères hexadécimaux attendus (32 octets).');
            console.error('   Générer une clé : node scripts/generate-keys.js');
            process.exit(1);
        }
        return Buffer.from(raw, 'hex');
    }
    if (isProd) {
        console.error('❌ AUDIT_HMAC_KEY manquante en production : le journal d\'audit ne serait pas inviolable.');
        console.error('   Générer une clé : node scripts/generate-keys.js');
        process.exit(1);
    }
    console.warn('⚠️ AUDIT_HMAC_KEY absente : clé dérivée de JWT_SECRET (dev uniquement).');
    return crypto.createHash('sha256').update(config.jwt.secret + 'audit_hmac_salt').digest();
}

// Clé HMAC du journal d'audit (32 octets), attendue en hex (64 caractères), hors base.
const AUDIT_HMAC_KEY = loadAuditKey();

function computeHash(eventType, userId, ipHash, detailsJson, createdAt, prevHash) {
    const payload = [eventType, userId || '', ipHash || '', detailsJson, createdAt].join('|');
    return crypto.createHmac('sha256', AUDIT_HMAC_KEY).update(payload + prevHash).digest('hex');
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
