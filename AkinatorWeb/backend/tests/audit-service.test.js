const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { db } = require('./helpers/setup');
const { appendAudit, verifyAuditChain } = require('../services/auditService');

test('appendAudit chaîne les hashs et verifyAuditChain valide', () => {
    appendAudit('auth.login.success', { userId: 'u1', ipHash: 'abcd', details: { username: 'alice' } });
    appendAudit('admin.user.promote', { userId: 'admin1', details: { target: 'u2' } });
    appendAudit('payment.webhook.settled', { details: { invoiceId: 'inv_1' } });

    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    assert.strictEqual(rows[0].prev_hash, 'GENESIS');
    assert.strictEqual(rows[1].prev_hash, rows[0].hash);
    assert.deepStrictEqual(verifyAuditChain(), { valid: true, count: 3 });
});

test('toute altération casse la chaîne', () => {
    db.prepare(`UPDATE audit_log SET details = '{"username":"eve"}' WHERE id = 1`).run();
    const result = verifyAuditChain();
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.brokenAt, 1);
});

test('le hash est un HMAC-SHA256 keyé (pas un simple SHA-256)', () => {
    appendAudit('test.event', { userId: 'u1', ipHash: 'ip1', details: { k: 'v' } });

    const row = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
    const payload = [row.event_type, row.user_id || '', row.ip_hash || '', row.details, row.created_at].join('|');

    // Clé de test : fallback dev dérivé de JWT_SECRET (NODE_ENV=test, AUDIT_HMAC_KEY absente)
    const key = crypto.createHash('sha256').update(process.env.JWT_SECRET + 'audit_hmac_salt').digest();

    const expectedHmac = crypto.createHmac('sha256', key).update(payload + row.prev_hash).digest('hex');
    assert.strictEqual(row.hash, expectedHmac, 'le hash doit être un HMAC-SHA256 avec la clé hors base');

    const simpleSha256 = crypto.createHash('sha256').update(payload + row.prev_hash).digest('hex');
    assert.notStrictEqual(row.hash, simpleSha256, 'le hash ne doit PAS être un simple SHA-256 non keyé');
});
