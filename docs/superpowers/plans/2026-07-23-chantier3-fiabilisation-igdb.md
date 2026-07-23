# Chantier 3 — Fiabilisation IGDB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Des recommandations de jeux fidèles aux filtres choisis : plus aucun filtre ignoré silencieusement (cause du bug « The Witcher 3 en post-apocalyptique »), mappings corrigés, résolution dynamique des slugs via l'API IGDB avec cache DB.

**Architecture:** La logique de résolution des filtres et de construction de requête sort de `services/igdb.js` vers un module pur et testable `services/igdbFilters.js` (mappings corrigés multi-ID et cross-facette + fonctions pures). `igdb.js` garde le réseau (OAuth, requêtes) et gagne une résolution dynamique slug→ID persistée dans la table `igdb_cache` existante (`queries.cache`). Un contrôle au démarrage vérifie que chaque slug de l'arbre de décision est résoluble. `services/igdbService.js` (code mort) est supprimé.

**Diagnostic (vérifié dans le code) :**
- `post-apocalyptic` est proposé dans l'arbre (`server.js`, seed des thèmes) mais **absent** de `FILTER_MAPPINGS.themes` (`services/igdb.js:218-236`) → le filtre est ignoré sans trace → la requête ne contient que genre+plateforme+mode triés par note → Witcher 3 remonte.
- Mappings faux : genre `action` → 25 (Hack and slash), genre `horreur/horror` → 31 (Adventure) alors qu'IGDB n'a **pas** de genre Action ni Horror (ce sont les thèmes 1 et 19) ; `battle-royale` → 5 (qui est MMO ; Battle Royale = 6) ; `playstation` → 48 seul (PS4) et `xbox` → 49 seul (One) au lieu des familles de plateformes.
- Un seul choix par catégorie dans l'arbre : le vrai problème n'est pas OU/ET mais les filtres perdus ; entre catégories les conditions sont déjà combinées par `&`.

**Tech Stack:** Node/Express 4, better-sqlite3 (`queries.cache` sur `igdb_cache`), axios, node --test + supertest.

**Spec:** `docs/superpowers/specs/2026-07-23-retrait-paiement-audit-credits-igdb-design.md`

## Global Constraints

- Tests : `/usr/bin/node --test tests/` depuis `AkinatorWeb/backend` (le node par défaut v24 ne compile pas better-sqlite3). Aucun test ne doit toucher le réseau : les tests unitaires ciblent les fonctions pures et la résolution avec « fetcher » injecté.
- Un filtre non résoluble n'est JAMAIS ignoré silencieusement : `console.warn` explicite côté serveur uniquement ; le contrat de retour de `searchGamesByFilters` (et donc de `routes/game.js`) reste inchangé, aucun champ `ignoredFilters` n'est exposé à l'appelant.
- Ne pas casser le contrat de `POST /api/game/recommend` (`routes/game.js:254-333`) : `data.games`, `data.filters`, `data.count` inchangés.
- Comportements réseau existants conservés : token OAuth caché, timeouts, fallback `getPopularGames` en cas d'erreur.
- Commits en français (conventional commits), suffixe `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Module pur `igdbFilters.js` — mappings corrigés + construction de requête

**Files:**
- Create: `AkinatorWeb/backend/services/igdbFilters.js`
- Test (create): `AkinatorWeb/backend/tests/igdb-filters.test.js`

**Interfaces:**
- Consumes: rien (module pur, zéro I/O).
- Produces (utilisés par Task 2) :
  - `STATIC_MAPPINGS` : `{ [facet]: { [slug]: { facet, ids } } }` — une entrée peut rediriger vers une autre facette (ex. genre `horror` → thème 19).
  - `async resolveFilters(filters, dynamicResolve)` → `{ resolved: { genres: [], platforms: [], themes: [], gameModes: [], keywords: [] }, ignored: [slug…] }`. `filters` = `[{ filterType|filter_type, slug, text }]` ; `dynamicResolve(facet, slug)` = fonction async renvoyant `{ facet, ids }` ou `null` (appelée seulement si le slug n'est pas dans `STATIC_MAPPINGS`).
  - `buildGamesQuery(resolved, limit = 15)` → chaîne APICalypse complète (fields/where/sort/limit).
  - `normalizeSlug(str)` (déplacé depuis `igdb.js:107-116`, identique).

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `AkinatorWeb/backend/tests/igdb-filters.test.js` :

```js
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
```

- [ ] **Step 2: Vérifier l'échec**

Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/igdb-filters.test.js`
Expected: FAIL — `Cannot find module '../services/igdbFilters'`.

- [ ] **Step 3: Implémenter `services/igdbFilters.js`**

```js
/**
 * Résolution des filtres de l'arbre de décision vers les IDs IGDB
 * et construction de la requête APICalypse. Module pur (zéro I/O) :
 * la résolution dynamique est injectée par l'appelant (services/igdb.js).
 *
 * IDs de référence : https://api-docs.igdb.com
 * Genres : 2 Point-and-click, 4 Fighting, 5 Shooter, 8 Platform, 9 Puzzle,
 *   10 Racing, 11 RTS, 12 RPG, 13 Simulator, 14 Sport, 15 Strategy, 16 TBS,
 *   24 Tactical, 25 Hack and slash, 31 Adventure, 32 Indie, 33 Arcade,
 *   34 Visual Novel, 36 MOBA. (Pas de genre Action ni Horror : ce sont les
 *   thèmes 1 et 19.)
 * Thèmes : 1 Action, 17 Fantasy, 18 Science fiction, 19 Horror, 21 Survival,
 *   22 Historical, 31 Drama, 38 Open world, 39 Warfare.
 * Plateformes : 6 PC(win), 7 PS1, 8 PS2, 9 PS3, 48 PS4, 167 PS5, 11 Xbox,
 *   12 X360, 49 One, 169 Series X|S, 130 Switch, 34 Android, 39 iOS.
 * Modes : 1 Single player, 2 Multiplayer, 3 Co-operative, 4 Split screen,
 *   5 MMO, 6 Battle Royale.
 */

// facet cible → clé de `resolved` ; une entrée peut rediriger vers une autre
// facette que sa catégorie d'arbre (ex. genre horror → thème 19).
const STATIC_MAPPINGS = {
    genre: {
        'action':           { facet: 'themes', ids: [1] },
        'aventure':         { facet: 'genres', ids: [31] },
        'adventure':        { facet: 'genres', ids: [31] },
        'rpg':              { facet: 'genres', ids: [12] },
        'role-playing':     { facet: 'genres', ids: [12] },
        'role-playing-rpg': { facet: 'genres', ids: [12] },
        'fps':              { facet: 'genres', ids: [5] },
        'shooter':          { facet: 'genres', ids: [5] },
        'fps-shooter':      { facet: 'genres', ids: [5] },
        'tir':              { facet: 'genres', ids: [5] },
        'sport':            { facet: 'genres', ids: [14] },
        'strategie':        { facet: 'genres', ids: [15] },
        'strategy':         { facet: 'genres', ids: [15] },
        'rts':              { facet: 'genres', ids: [11] },
        'tbs':              { facet: 'genres', ids: [16] },
        'simulation':       { facet: 'genres', ids: [13] },
        'simulator':        { facet: 'genres', ids: [13] },
        'puzzle':           { facet: 'genres', ids: [9] },
        'horreur':          { facet: 'themes', ids: [19] },
        'horror':           { facet: 'themes', ids: [19] },
        'indie':            { facet: 'genres', ids: [32] },
        'plateforme':       { facet: 'genres', ids: [8] },
        'platform':         { facet: 'genres', ids: [8] },
        'course':           { facet: 'genres', ids: [10] },
        'racing':           { facet: 'genres', ids: [10] },
        'combat':           { facet: 'genres', ids: [4] },
        'fighting':         { facet: 'genres', ids: [4] },
        'arcade':           { facet: 'genres', ids: [33] },
        'moba':             { facet: 'genres', ids: [36] },
        'tactique':         { facet: 'genres', ids: [24] },
        'tactical':         { facet: 'genres', ids: [24] },
        'visual-novel':     { facet: 'genres', ids: [34] },
        'point-and-click':  { facet: 'genres', ids: [2] }
    },
    platform: {
        'pc':              { facet: 'platforms', ids: [6] },
        'win':             { facet: 'platforms', ids: [6] },
        'windows':         { facet: 'platforms', ids: [6] },
        'playstation':     { facet: 'platforms', ids: [7, 8, 9, 48, 167] },
        'ps4':             { facet: 'platforms', ids: [48] },
        'playstation-4':   { facet: 'platforms', ids: [48] },
        'ps5':             { facet: 'platforms', ids: [167] },
        'playstation-5':   { facet: 'platforms', ids: [167] },
        'xbox':            { facet: 'platforms', ids: [11, 12, 49, 169] },
        'xbox-one':        { facet: 'platforms', ids: [49] },
        'xbox-series':     { facet: 'platforms', ids: [169] },
        'xbox-series-x':   { facet: 'platforms', ids: [169] },
        'switch':          { facet: 'platforms', ids: [130] },
        'nintendo-switch': { facet: 'platforms', ids: [130] },
        'mobile':          { facet: 'platforms', ids: [34, 39] },
        'android':         { facet: 'platforms', ids: [34] },
        'ios':             { facet: 'platforms', ids: [39] }
    },
    theme: {
        'science-fiction': { facet: 'themes', ids: [18] },
        'sci-fi':          { facet: 'themes', ids: [18] },
        'fantasy':         { facet: 'themes', ids: [17] },
        'guerre':          { facet: 'themes', ids: [39] },
        'warfare':         { facet: 'themes', ids: [39] },
        'war':             { facet: 'themes', ids: [39] },
        'survie':          { facet: 'themes', ids: [21] },
        'survival':        { facet: 'themes', ids: [21] },
        'open-world':      { facet: 'themes', ids: [38] },
        'monde-ouvert':    { facet: 'themes', ids: [38] },
        'horreur':         { facet: 'themes', ids: [19] },
        'horror':          { facet: 'themes', ids: [19] },
        'action':          { facet: 'themes', ids: [1] },
        'drame':           { facet: 'themes', ids: [31] },
        'drama':           { facet: 'themes', ids: [31] },
        'historique':      { facet: 'themes', ids: [22] },
        'historical':      { facet: 'themes', ids: [22] }
        // 'post-apocalyptic' : pas un thème IGDB — résolu dynamiquement (keyword)
    },
    game_mode: {
        'solo':           { facet: 'gameModes', ids: [1] },
        'single-player':  { facet: 'gameModes', ids: [1] },
        'joueur-unique':  { facet: 'gameModes', ids: [1] },
        'multijoueur':    { facet: 'gameModes', ids: [2] },
        'multiplayer':    { facet: 'gameModes', ids: [2] },
        'coop':           { facet: 'gameModes', ids: [3] },
        'co-operative':   { facet: 'gameModes', ids: [3] },
        'cooperative':    { facet: 'gameModes', ids: [3] },
        'local-coop':     { facet: 'gameModes', ids: [4] },
        'battle-royale':  { facet: 'gameModes', ids: [6] },
        'mmo':            { facet: 'gameModes', ids: [5] }
    }
};

function normalizeSlug(str) {
    if (!str) return '';
    return str
        .trim()
        .toLowerCase()
        .replace(/[\s/()]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function emptyResolved() {
    return { genres: [], platforms: [], themes: [], gameModes: [], keywords: [] };
}

/**
 * Résout une liste de filtres de l'arbre en IDs IGDB par facette.
 * dynamicResolve(facet, slug) est appelé pour tout slug absent du statique ;
 * il renvoie { facet, ids } ou null. Les slugs irrésolubles finissent dans
 * `ignored` (format "type:slug") — à logger par l'appelant, jamais avalés.
 */
async function resolveFilters(filters, dynamicResolve) {
    const resolved = emptyResolved();
    const ignored = [];

    for (const filter of filters || []) {
        const filterType = filter.filterType || filter.filter_type;
        const slug = normalizeSlug(filter.slug || filter.text);
        if (!filterType || !slug) continue;

        const staticEntry = (STATIC_MAPPINGS[filterType] || {})[slug];
        const entry = staticEntry || await dynamicResolve(filterType, slug);

        if (entry && Array.isArray(entry.ids) && entry.ids.length > 0 && resolved[entry.facet]) {
            for (const id of entry.ids) {
                if (!resolved[entry.facet].includes(id)) {
                    resolved[entry.facet].push(id);
                }
            }
        } else {
            ignored.push(`${filterType}:${slug}`);
        }
    }

    return { resolved, ignored };
}

/**
 * Construit la requête APICalypse /games. Les IDs d'une même facette sont en
 * OU (familles de plateformes) ; les facettes sont combinées en ET.
 */
function buildGamesQuery(resolved, limit = 15) {
    const conditions = [];
    const facetFields = [
        ['genres', 'genres'],
        ['platforms', 'platforms'],
        ['themes', 'themes'],
        ['gameModes', 'game_modes'],
        ['keywords', 'keywords']
    ];

    for (const [facet, field] of facetFields) {
        const ids = resolved[facet] || [];
        if (ids.length > 0) {
            conditions.push(`${field} = (${ids.join(',')})`);
        }
    }

    conditions.push('cover != null');

    return `fields name, cover.url, rating, summary, genres.name, platforms.name, first_release_date; where ${conditions.join(' & ')}; sort rating desc; limit ${limit};`;
}

module.exports = { STATIC_MAPPINGS, normalizeSlug, resolveFilters, buildGamesQuery, emptyResolved };
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/igdb-filters.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/services/igdbFilters.js AkinatorWeb/backend/tests/igdb-filters.test.js
git commit -m "feat(igdb): module pur de résolution des filtres avec mappings corrigés"
```

---

### Task 2: `igdb.js` — résolution dynamique avec cache DB + branchement du nouveau module

**Files:**
- Modify: `AkinatorWeb/backend/services/igdb.js`
- Test (create): `AkinatorWeb/backend/tests/igdb-dynamic-resolve.test.js`
- Delete: `AkinatorWeb/backend/services/igdbService.js` (code mort — vérifier avant : `grep -rn "igdbService" AkinatorWeb --include=*.js | grep -v node_modules` ne doit montrer aucun import)

**Interfaces:**
- Consumes: `resolveFilters`, `buildGamesQuery`, `normalizeSlug` (Task 1) ; `queries.cache` (`database.js:370-380` : `get(cache_key)` → `{ data }`, `set(cache_key, data, ttlMinutes?)` — vérifier la signature exacte dans `database.js` avant usage).
- Produces:
  - `searchGamesByFilters(filters)` : contrat inchangé pour `routes/game.js` (retourne un tableau de jeux formatés) MAIS la fonction logge `⚠️ Filtres ignorés: …` pour chaque slug irrésoluble.
  - `resolveSlugDynamic(filterType, slug)` exporté : essaie l'endpoint de la facette (genre→`genres`, platform→`platforms`, theme→`themes`, game_mode→`gameModes` ; requête `fields id,slug; where slug = "<slug>"; limit 1;`), puis pour un thème introuvable retente sur `keywords`. Résultat (y compris négatif) persisté dans `igdb_cache` (clé `igdb:resolve:<type>:<slug>`, TTL 7 jours). Renvoie `{ facet, ids }` ou `null`.
  - `_test` : export `{ resolveSlugDynamicWith(requestFn) }` — fabrique permettant d'injecter le `igdbRequest` (les tests ne touchent pas le réseau).

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `AkinatorWeb/backend/tests/igdb-dynamic-resolve.test.js` :

```js
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
```

- [ ] **Step 2: Vérifier l'échec**

Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/igdb-dynamic-resolve.test.js`
Expected: FAIL — `_test` n'existe pas.

- [ ] **Step 3: Implémenter dans `igdb.js`**

- Supprimer `FILTER_MAPPINGS` (l.150-251), `normalizeSlug` (l.104-116), `fetchFilterId` et le `filterCache`/`FILTER_CACHE_TTL` mémoire (l.31-33, 118-147) — remplacés par le module pur + cache DB.
- Ajouter en tête : `const { resolveFilters, buildGamesQuery, normalizeSlug } = require('./igdbFilters');` et `const { queries } = require('./database');`.
- Ajouter la résolution dynamique (fabrique + instance par défaut) :

```js
const RESOLVE_CACHE_TTL_MINUTES = 7 * 24 * 60; // 7 jours

// Endpoints de résolution par type de filtre de l'arbre ; un thème introuvable
// retente sur keywords (IGDB n'a pas de thème pour tout, ex. post-apocalyptic).
const RESOLVE_CHAIN = {
    genre: [['genres', ENDPOINTS.genres]],
    platform: [['platforms', ENDPOINTS.platforms]],
    theme: [['themes', ENDPOINTS.themes], ['keywords', `${IGDB_BASE_URL}/keywords`]],
    game_mode: [['gameModes', ENDPOINTS.gameModes]]
};

function resolveSlugDynamicWith(requestFn) {
    return async function resolveSlugDynamic(filterType, slug) {
        const cacheKey = `igdb:resolve:${filterType}:${slug}`;
        const cached = queries.cache.get.get(cacheKey);
        if (cached) {
            return JSON.parse(cached.data);
        }

        const chain = RESOLVE_CHAIN[filterType] || [];
        try {
            for (const [facet, endpoint] of chain) {
                const sanitized = slug.replace(/["\\;']/g, '');
                const results = await requestFn(endpoint, `fields id,slug; where slug = "${sanitized}"; limit 1;`);
                if (results && results.length > 0) {
                    const entry = { facet, ids: [results[0].id] };
                    queries.cache.set.run(cacheKey, JSON.stringify(entry), RESOLVE_CACHE_TTL_MINUTES);
                    return entry;
                }
            }
            // Échec définitif : caché aussi (évite de marteler l'API à chaque partie)
            queries.cache.set.run(cacheKey, JSON.stringify(null), RESOLVE_CACHE_TTL_MINUTES);
            return null;
        } catch (error) {
            console.warn(`⚠️ Résolution IGDB échouée pour ${filterType}:${slug} — ${error.message}`);
            return null; // erreur réseau : pas de cache, on retentera
        }
    };
}

const resolveSlugDynamic = resolveSlugDynamicWith(igdbRequest);
```

**Attention** : adapter l'appel `queries.cache.set` à la signature réelle de `database.js` (l.370-380) — si le prepared statement attend `(cache_key, data, expires_at)` avec un datetime, passer `datetime('now', '+X minutes')` côté SQL ou calculer l'ISO string ici ; lire le statement avant d'écrire cet appel. De même pour `queries.cache.get` (peut déjà filtrer `expires_at > datetime('now')`).

- Réécrire `searchGamesByFilters` :

```js
async function searchGamesByFilters(filters) {
    if (!filters || filters.length === 0) {
        console.log('⚠️ Aucun filtre fourni pour la recherche');
        return getPopularGames(15);
    }

    console.log('🔍 Recherche IGDB avec filtres:', filters.map(f => f.text || f.slug));

    const { resolved, ignored } = await resolveFilters(filters, resolveSlugDynamic);

    if (ignored.length > 0) {
        console.warn(`⚠️ Filtres ignorés (aucune correspondance IGDB): ${ignored.join(', ')}`);
    }

    const body = buildGamesQuery(resolved, 15);
    console.log('📤 Requête IGDB:', body);

    try {
        const games = await igdbRequest(ENDPOINTS.games, body);
        const formattedGames = games.map(formatGame);
        console.log(`✅ ${formattedGames.length} jeux trouvés`);
        return formattedGames;
    } catch (error) {
        console.error('❌ Erreur recherche IGDB:', error.message);
        return [];
    }
}
```

- Extraire le formatage dupliqué (actuellement copié dans `searchGamesByFilters` et `getPopularGames`) en une fonction `formatGame(game)` unique (champs identiques à l'existant : id, name, cover `t_cover_big`, rating arrondi, summary tronqué à 200, genres, platforms, releaseYear ; `getPopularGames` n'expose pas `platforms` aujourd'hui — l'y ajouter est OK, le front l'ignore).
- Exports : ajouter `_test: { resolveSlugDynamicWith }` et `resolveSlugDynamic` au `module.exports` existant.
- `git rm AkinatorWeb/backend/services/igdbService.js` après le grep de vérification.

- [ ] **Step 4: Vérifier que les tests passent, puis la suite**

Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/igdb-dynamic-resolve.test.js` → PASS (4 tests).
Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/` → PASS (aucune régression ; `igdb-filters.test.js` de Task 1 inclus).

- [ ] **Step 5: Commit**

```bash
git add -A AkinatorWeb/backend
git commit -m "feat(igdb): résolution dynamique des slugs avec cache DB, filtres ignorés loggés"
```

---

### Task 3: Contrôle de cohérence de l'arbre au démarrage

**Files:**
- Modify: `AkinatorWeb/backend/server.js` (fin de `initializeDecisionTree` / `startServer`)
- Test (create): `AkinatorWeb/backend/tests/tree-slugs-static.test.js`

**Interfaces:**
- Consumes: `queries.tree.getAll`, `STATIC_MAPPINGS` + `resolveFilters` (Task 1), `resolveSlugDynamic` (Task 2).
- Produces: `validateTreeSlugs()` exporté de `server.js` — pour chaque nœud de l'arbre avec `slug_igdb`, vérifie la résolution (statique puis dynamique) et `console.warn` chaque slug irrésoluble. Appelée au boot après `initializeDecisionTree()` si `TWITCH_CLIENT_ID` est défini, dans un `try/catch` non bloquant.

- [ ] **Step 1: Test statique (sans réseau) qui échoue**

Créer `AkinatorWeb/backend/tests/tree-slugs-static.test.js` :

```js
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
```

Note : `server.js` n'exporte pas `initializeDecisionTree` aujourd'hui (`module.exports = { app }`) — l'ajouter à l'export fait partie du Step 3.

- [ ] **Step 2: Vérifier l'échec**

Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/tree-slugs-static.test.js`
Expected: FAIL — `initializeDecisionTree` non exporté.

- [ ] **Step 3: Implémenter**

Dans `server.js` :
- Exporter : `module.exports = { app, initializeDecisionTree, validateTreeSlugs };`
- Ajouter après `initializeDecisionTree` :

```js
/**
 * Vérifie que chaque slug de l'arbre est résoluble côté IGDB (statique puis
 * dynamique). Warn uniquement — ne bloque jamais le démarrage.
 */
async function validateTreeSlugs() {
    const { queries } = require('./services/database');
    const { resolveFilters } = require('./services/igdbFilters');
    const { resolveSlugDynamic } = require('./services/igdb');

    const nodes = queries.tree.getAll.all().filter(n => n.slug_igdb);
    const filters = nodes.map(n => ({ filterType: n.filter_type, slug: n.slug_igdb, text: n.question_text }));
    const { ignored } = await resolveFilters(filters, resolveSlugDynamic);

    if (ignored.length > 0) {
        console.warn(`⚠️ Arbre de décision: ${ignored.length} slug(s) irrésoluble(s) côté IGDB — ces filtres seront ignorés en partie: ${[...new Set(ignored)].join(', ')}`);
    } else {
        console.log('✅ Arbre de décision: tous les slugs sont résolubles côté IGDB');
    }
}
```

- Dans `startServer()`, après `await initializeDecisionTree();` :

```js
        // Contrôle de cohérence arbre ↔ IGDB (non bloquant, nécessite les creds Twitch)
        if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
            validateTreeSlugs().catch(err =>
                console.warn('⚠️ Validation des slugs IGDB impossible:', err.message));
        }
```

- [ ] **Step 4: Vérifier tests + suite**

Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/tree-slugs-static.test.js` → PASS.
Run: `cd AkinatorWeb/backend && /usr/bin/node --test tests/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/server.js AkinatorWeb/backend/tests/tree-slugs-static.test.js
git commit -m "feat(igdb): contrôle de cohérence des slugs de l'arbre au démarrage"
```

---

### Task 4: Documentation + vérification manuelle bout-en-bout

**Files:**
- Modify: `README.md`, `docs/architecture.md` (mentions d'`igdbService.js` mort, description du flux de recommandation)

**Interfaces:** aucune.

- [ ] **Step 1: Docs**

Dans `docs/architecture.md` : mettre à jour la table des services (`igdb.js` = réseau/OAuth/résolution dynamique + cache `igdb_cache` ; `igdbFilters.js` = mappings et construction de requête ; retirer `igdbService.js`). Décrire en 3 lignes le comportement « filtre irrésoluble ⇒ warn + ignoré explicitement ».

- [ ] **Step 2: Vérification manuelle (si creds Twitch disponibles dans `.env`)**

Lancer le serveur, jouer une partie RPG → PC → Post-Apocalyptique → Solo, et vérifier dans les logs : la requête IGDB contient `keywords = (…)` (ou le thème résolu) et AUCUN warning « Filtres ignorés ». Vérifier que les jeux retournés sont cohérents (pas de Witcher 3 si le keyword est appliqué… sauf si IGDB le tagge ainsi — l'important est que le filtre soit dans la requête). Sans creds : constater au boot `⚠️ Variable optionnelle manquante` et l'absence de crash.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: architecture IGDB (igdbFilters, résolution dynamique, cache DB)"
```
