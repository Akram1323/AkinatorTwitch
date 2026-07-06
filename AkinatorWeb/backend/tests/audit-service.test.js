const { test } = require('node:test');
const assert = require('node:assert');
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
