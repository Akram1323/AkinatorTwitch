/**
 * Service de jetons : access court (15 min) + refresh rotatif.
 * - Refresh opaque (96 hex), stocké hashé (SHA-256) en base.
 * - Rotation : chaque refresh n'est utilisable qu'une fois.
 * - Reuse detection : un refresh déjà utilisé/révoqué qui resurgit
 *   → toute la famille est révoquée (vol probable).
 * - Blacklist access persistante par jti.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const { db } = require('./database');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TTL_DAYS = 7;

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            is_admin: user.is_admin === 1,
            jti: uuidv4()
        },
        config.jwt.secret,
        { expiresIn: ACCESS_TOKEN_TTL, algorithm: config.jwt.algorithm }
    );
}

function issueRefreshToken(userId, familyId = null) {
    const token = crypto.randomBytes(48).toString('hex');
    const family = familyId || uuidv4();
    db.prepare(`
        INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
        VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' days'))
    `).run(uuidv4(), userId, family, hashToken(token), REFRESH_TTL_DAYS);
    return { token, familyId: family };
}

function issueTokenPair(user) {
    const { token: refreshToken, familyId } = issueRefreshToken(user.id);
    return { accessToken: signAccessToken(user), refreshToken, familyId };
}

function revokeFamily(familyId) {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE family_id = ?').run(familyId);
}

function revokeFamilyByToken(presentedToken) {
    const row = db.prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?')
        .get(hashToken(presentedToken));
    if (row) revokeFamily(row.family_id);
}

function rotateRefreshToken(presentedToken) {
    const row = db.prepare(`
        SELECT *, (expires_at < datetime('now')) AS expired
        FROM refresh_tokens WHERE token_hash = ?
    `).get(hashToken(presentedToken));

    if (!row) return { ok: false, reason: 'unknown' };

    if (row.revoked || row.used_at) {
        // Réutilisation détectée → vol probable → révocation de toute la famille
        revokeFamily(row.family_id);
        return { ok: false, reason: 'reuse' };
    }
    if (row.expired) return { ok: false, reason: 'expired' };

    db.prepare(`UPDATE refresh_tokens SET used_at = datetime('now') WHERE id = ?`).run(row.id);
    const { token } = issueRefreshToken(row.user_id, row.family_id);
    return { ok: true, userId: row.user_id, newToken: token };
}

function revokeAccessToken(decodedPayload) {
    if (!decodedPayload || !decodedPayload.jti) return;
    const expiresAt = new Date((decodedPayload.exp || 0) * 1000).toISOString();
    db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)')
        .run(decodedPayload.jti, expiresAt);
}

function isJtiRevoked(jti) {
    if (!jti) return false;
    return !!db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(jti);
}

function purgeExpiredTokens() {
    const a = db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < datetime('now')`).run();
    const b = db.prepare(`DELETE FROM revoked_tokens WHERE expires_at < datetime('now')`).run();
    return a.changes + b.changes;
}

module.exports = {
    signAccessToken,
    issueTokenPair,
    rotateRefreshToken,
    revokeFamily,
    revokeFamilyByToken,
    revokeAccessToken,
    isJtiRevoked,
    purgeExpiredTokens,
    ACCESS_TOKEN_TTL,
    REFRESH_TTL_DAYS
};
