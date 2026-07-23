const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

// Route accessible anonymement : chaque slug inconnu déclenche jusqu'à 2 appels
// IGDB sortants + une écriture cache. Le plafond doit tomber AVANT toute
// résolution IGDB (pas d'appel réseau attendu dans ces tests).

test('POST /api/game/recommend sans auth avec 11 filtres → 400', async () => {
    const filters = Array.from({ length: 11 }, (_, i) => ({
        type: 'genre',
        slug: `slug-${i}`,
        text: `Filtre ${i}`
    }));

    const res = await request(app)
        .post('/api/game/recommend')
        .send({ filters });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error, 'Filtres invalides (maximum 10)');
});

test('POST /api/game/recommend avec filters non-tableau (objet) → 400', async () => {
    const res = await request(app)
        .post('/api/game/recommend')
        .send({ filters: { type: 'genre', slug: 'rpg', text: 'RPG' } });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error, 'Filtres invalides (maximum 10)');
});
