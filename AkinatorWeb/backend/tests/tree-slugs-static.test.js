const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { STATIC_MAPPINGS } = require('../services/igdbFilters');

// Garde-fou : tout slug seedé dans l'arbre doit être mappé statiquement,
// SAUF la liste explicite des slugs résolus dynamiquement (keywords IGDB).
const DYNAMIC_ONLY = new Set(['theme:post-apocalyptic']);

test('chaque slug de l\'arbre seedé est résoluble statiquement (ou listé dynamique)', () => {
    const { initializeDecisionTree } = require('../server');
    // initializeDecisionTree est async mais purement synchrone en pratique (better-sqlite3)
    return initializeDecisionTree().then(() => {
        const nodes = db.prepare('SELECT DISTINCT filter_type, slug_igdb FROM decision_tree WHERE slug_igdb IS NOT NULL').all();
        assert.ok(nodes.length > 0, 'l\'arbre doit être seedé');
        const unmapped = nodes
            .filter(n => !(STATIC_MAPPINGS[n.filter_type] || {})[n.slug_igdb])
            .map(n => `${n.filter_type}:${n.slug_igdb}`)
            .filter(key => !DYNAMIC_ONLY.has(key));
        assert.deepStrictEqual(unmapped, [], `slugs de l'arbre sans mapping statique ni entrée DYNAMIC_ONLY: ${unmapped}`);
    });
});
