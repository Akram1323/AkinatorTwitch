const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

test('GET /api/health répond 200 avec success:true', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
});
