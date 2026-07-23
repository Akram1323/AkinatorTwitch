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
