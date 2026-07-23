const { test } = require('node:test');
const assert = require('node:assert');
const { resolveFilters, buildGamesQuery, STATIC_MAPPINGS, normalizeSlug } = require('../services/igdbFilters');

const noDynamic = async () => null;

test('les slugs de l\'arbre de décision sont tous mappés statiquement', async () => {
    // Slugs seedés par initializeDecisionTree (server.js) — post-apocalyptic est
    // volontairement absent : il se résout dynamiquement (keyword IGDB).
    const treeSlugs = [
        ['genre', ['action', 'adventure', 'role-playing-rpg', 'shooter', 'sport', 'strategy', 'simulator', 'puzzle', 'horror', 'indie']],
        ['platform', ['win', 'playstation', 'xbox', 'switch', 'mobile']],
        ['theme', ['science-fiction', 'fantasy', 'warfare', 'survival', 'open-world']],
        ['game_mode', ['single-player', 'multiplayer', 'co-operative', 'battle-royale']]
    ];
    for (const [type, slugs] of treeSlugs) {
        const filters = slugs.map(slug => ({ filterType: type, slug, text: slug }));
        const { resolved, ignored } = await resolveFilters(filters, noDynamic);
        assert.deepStrictEqual(ignored, [], `slugs ${type} non mappés: ${ignored}`);
        const total = Object.values(resolved).reduce((n, ids) => n + ids.length, 0);
        assert.ok(total > 0, `aucun ID résolu pour ${type}`);
    }
});

test('corrections de mappings : horror→thème 19, action→thème 1, battle-royale→mode 6', async () => {
    const { resolved } = await resolveFilters([
        { filterType: 'genre', slug: 'horror', text: 'Horreur' },
        { filterType: 'genre', slug: 'action', text: 'Action' },
        { filterType: 'game_mode', slug: 'battle-royale', text: 'Battle Royale' }
    ], noDynamic);
    assert.ok(resolved.themes.includes(19), 'horror doit résoudre vers le thème IGDB 19');
    assert.ok(resolved.themes.includes(1), 'action doit résoudre vers le thème IGDB 1');
    assert.deepStrictEqual(resolved.gameModes, [6], 'battle-royale = game mode 6 (5 est MMO)');
    assert.strictEqual(resolved.genres.length, 0, 'ni horror ni action ne sont des genres IGDB');
});

test('familles de plateformes : playstation et xbox couvrent toutes les générations', async () => {
    const { resolved } = await resolveFilters([
        { filterType: 'platform', slug: 'playstation', text: 'PlayStation' }
    ], noDynamic);
    for (const id of [7, 8, 9, 48, 167]) {
        assert.ok(resolved.platforms.includes(id), `PS famille doit inclure ${id}`);
    }
});

test('slug inconnu du statique : résolution dynamique appelée, résultat intégré', async () => {
    const calls = [];
    const dynamic = async (facet, slug) => {
        calls.push([facet, slug]);
        if (slug === 'post-apocalyptic') return { facet: 'keywords', ids: [342] };
        return null;
    };
    const { resolved, ignored } = await resolveFilters([
        { filterType: 'theme', slug: 'post-apocalyptic', text: 'Post-Apocalyptique' }
    ], dynamic);
    assert.deepStrictEqual(calls, [['theme', 'post-apocalyptic']]);
    assert.deepStrictEqual(resolved.keywords, [342]);
    assert.deepStrictEqual(ignored, []);
});

test('slug irrésoluble : signalé dans ignored, jamais silencieux', async () => {
    const { resolved, ignored } = await resolveFilters([
        { filterType: 'theme', slug: 'nimporte-quoi', text: 'X' },
        { filterType: 'genre', slug: 'rpg', text: 'RPG' }
    ], noDynamic);
    assert.deepStrictEqual(ignored, ['theme:nimporte-quoi']);
    assert.deepStrictEqual(resolved.genres, [12], 'les filtres valides restent appliqués');
});

test('buildGamesQuery : toutes les facettes présentes, combinées en ET', () => {
    const body = buildGamesQuery({
        genres: [12], platforms: [48, 167], themes: [19], gameModes: [1], keywords: [342]
    });
    assert.match(body, /genres = \(12\)/);
    assert.match(body, /platforms = \(48,167\)/);
    assert.match(body, /themes = \(19\)/);
    assert.match(body, /game_modes = \(1\)/);
    assert.match(body, /keywords = \(342\)/);
    assert.match(body, /cover != null/);
    // ET entre catégories
    const whereClause = body.match(/where ([^;]+);/)[1];
    assert.strictEqual(whereClause.split(' & ').length, 6);
    assert.match(body, /sort rating desc/);
    assert.match(body, /limit 15/);
});

test('buildGamesQuery : facettes vides omises', () => {
    const body = buildGamesQuery({ genres: [], platforms: [6], themes: [], gameModes: [], keywords: [] });
    assert.doesNotMatch(body, /genres =/);
    assert.match(body, /platforms = \(6\)/);
});

test('normalizeSlug inchangé', () => {
    assert.strictEqual(normalizeSlug('  Post-Apocalyptique !'), 'post-apocalyptique');
    assert.strictEqual(normalizeSlug('FPS / Shooter'), 'fps-shooter');
});
