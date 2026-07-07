const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

test('Permissions-Policy et CSP report sont présents', async () => {
    const res = await request(app).get('/api/health');
    assert.match(res.headers['permissions-policy'] || '', /camera=\(\)/);
    assert.match(res.headers['content-security-policy'] || '', /report-uri \/api\/csp-report/);
    assert.match(res.headers['reporting-endpoints'] || '', /csp-endpoint/);
});

test('GET /.well-known/security.txt répond en texte brut (RFC 9116)', async () => {
    const res = await request(app).get('/.well-known/security.txt');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.match(res.text, /Contact: mailto:/);
    assert.match(res.text, /Expires: /);
});

test('POST /api/csp-report accepte un rapport de violation', async () => {
    const res = await request(app).post('/api/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }));
    assert.strictEqual(res.status, 204);
});
