const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeInput } = require('../middleware/security');

function run(body) {
    const req = { body, query: {}, params: {} };
    let called = false;
    sanitizeInput(req, {}, () => { called = true; });
    assert.ok(called, 'next() doit être appelé');
    return req.body;
}

test('sanitizeInput ne modifie pas les champs de mot de passe', () => {
    const out = run({ password: 'Ab1<x>Cd!ef', newPassword: 'Zz9<b>Yy!ww', currentPassword: 'Qq2<i>Ww!ee' });
    assert.strictEqual(out.password, 'Ab1<x>Cd!ef');
    assert.strictEqual(out.newPassword, 'Zz9<b>Yy!ww');
    assert.strictEqual(out.currentPassword, 'Qq2<i>Ww!ee');
});

test('sanitizeInput ne modifie pas les codes (code, a2fCode)', () => {
    const out = run({ code: 'a1<b>c2', a2fCode: '12<i>34' });
    assert.strictEqual(out.code, 'a1<b>c2');
    assert.strictEqual(out.a2fCode, '12<i>34');
});

test('sanitizeInput nettoie toujours les champs non sensibles', () => {
    const out = run({ username: 'bob<script>alert(1)</script>' });
    assert.ok(!out.username.includes('<'), 'les balises HTML sont retirées des champs normaux');
});
