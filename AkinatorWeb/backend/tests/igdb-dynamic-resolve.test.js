const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { _test } = require('../services/igdb');

function fakeRequest(responsesByEndpoint) {
    const calls = [];
    const fn = async (endpoint, body) => {
        calls.push({ endpoint, body });
        const key = Object.keys(responsesByEndpoint).find(k => endpoint.endsWith(k));
        return key ? responsesByEndpoint[key] : [];
    };
    fn.calls = calls;
    return fn;
}

test('résout un thème via l\'endpoint themes et persiste en cache DB', async () => {
    const request = fakeRequest({ '/themes': [{ id: 20, slug: 'thriller' }] });
    const resolve = _test.resolveSlugDynamicWith(request);

    const result = await resolve('theme', 'thriller');
    assert.deepStrictEqual(result, { facet: 'themes', ids: [20] });

    const cached = db.prepare("SELECT data FROM igdb_cache WHERE cache_key = 'igdb:resolve:theme:thriller'").get();
    assert.ok(cached, 'résultat persisté dans igdb_cache');
    assert.deepStrictEqual(JSON.parse(cached.data), { facet: 'themes', ids: [20] });

    // 2e appel : servi par le cache, pas de nouvelle requête réseau
    const before = request.calls.length;
    const again = await resolve('theme', 'thriller');
    assert.deepStrictEqual(again, { facet: 'themes', ids: [20] });
    assert.strictEqual(request.calls.length, before, 'pas de requête réseau sur cache hit');
});

test('thème introuvable → fallback keywords (cas post-apocalyptic)', async () => {
    const request = fakeRequest({
        '/themes': [],
        '/keywords': [{ id: 342, slug: 'post-apocalyptic' }]
    });
    const resolve = _test.resolveSlugDynamicWith(request);

    const result = await resolve('theme', 'post-apocalyptic');
    assert.deepStrictEqual(result, { facet: 'keywords', ids: [342] });
    assert.strictEqual(request.calls.length, 2, 'themes puis keywords');
    assert.match(request.calls[1].endpoint, /keywords/);
});

test('slug introuvable partout → null, résultat négatif caché (pas de re-requête)', async () => {
    const request = fakeRequest({ '/themes': [], '/keywords': [] });
    const resolve = _test.resolveSlugDynamicWith(request);

    assert.strictEqual(await resolve('theme', 'slug-fantome'), null);
    const before = request.calls.length;
    assert.strictEqual(await resolve('theme', 'slug-fantome'), null);
    assert.strictEqual(request.calls.length, before, 'échec aussi servi par le cache');
});

test('erreur réseau → null sans cache (on retentera plus tard)', async () => {
    const request = async () => { throw new Error('IGDB down'); };
    const resolve = _test.resolveSlugDynamicWith(request);

    assert.strictEqual(await resolve('genre', 'quiz'), null);
    const cached = db.prepare("SELECT data FROM igdb_cache WHERE cache_key = 'igdb:resolve:genre:quiz'").get();
    assert.strictEqual(cached, undefined, 'une erreur réseau ne doit pas être cachée');
});
