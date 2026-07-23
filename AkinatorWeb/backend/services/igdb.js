/**
 * Service IGDB (Internet Game Database)
 * Intégration avec l'API Twitch/IGDB pour la recommandation de jeux
 *
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const axios = require('axios');
const { resolveFilters, buildGamesQuery } = require('./igdbFilters');
const { queries } = require('./database');

// URLs de l'API
const TWITCH_OAUTH_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_BASE_URL = 'https://api.igdb.com/v4';

// Endpoints IGDB
const ENDPOINTS = {
    games: `${IGDB_BASE_URL}/games`,
    genres: `${IGDB_BASE_URL}/genres`,
    platforms: `${IGDB_BASE_URL}/platforms`,
    themes: `${IGDB_BASE_URL}/themes`,
    gameModes: `${IGDB_BASE_URL}/game_modes`,
    covers: `${IGDB_BASE_URL}/covers`
};

// Cache du token
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Obtient un token OAuth Twitch
 */
async function getAccessToken() {
    // Vérifier le cache
    const now = Date.now() / 1000;
    if (cachedToken && tokenExpiresAt > now + 300) {
        return cachedToken;
    }

    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET requis dans .env');
    }

    try {
        const response = await axios.post(TWITCH_OAUTH_URL, null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            },
            timeout: 10000
        });

        cachedToken = response.data.access_token;
        tokenExpiresAt = now + response.data.expires_in;

        console.log('🎮 Token IGDB obtenu avec succès');
        return cachedToken;

    } catch (error) {
        console.error('❌ Erreur obtention token Twitch:', error.message);
        throw new Error('Impossible d\'obtenir le token Twitch');
    }
}

/**
 * Effectue une requête à l'API IGDB
 */
async function igdbRequest(endpoint, body) {
    const token = await getAccessToken();
    const clientId = process.env.TWITCH_CLIENT_ID;

    try {
        const response = await axios.post(endpoint, body, {
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'Content-Type': 'text/plain'
            },
            timeout: 15000
        });

        return response.data;

    } catch (error) {
        if (error.response) {
            console.error(`❌ Erreur IGDB [${error.response.status}]:`, error.response.data);
        } else {
            console.error('❌ Erreur IGDB:', error.message);
        }
        throw error;
    }
}

const RESOLVE_CACHE_TTL_MINUTES = 7 * 24 * 60; // 7 jours

// queries.cache.set attend (cache_key, data, modificateur_datetime_sqlite) —
// voir services/database.js (~l.378) : le 3e paramètre est passé tel quel à
// `datetime('now', ?)`, d'où la conversion en chaîne "+X minutes" ici.
function cacheTtlModifier(minutes) {
    return `+${minutes} minutes`;
}

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
            try {
                return JSON.parse(cached.data);
            } catch (parseError) {
                console.warn(`⚠️ Cache IGDB corrompu pour ${cacheKey} — traité comme cache miss: ${parseError.message}`);
            }
        }

        const chain = RESOLVE_CHAIN[filterType] || [];
        try {
            for (const [facet, endpoint] of chain) {
                const sanitized = slug.replace(/["\\;']/g, '');
                const results = await requestFn(endpoint, `fields id,slug; where slug = "${sanitized}"; limit 1;`);
                if (results && results.length > 0) {
                    const entry = { facet, ids: [results[0].id] };
                    queries.cache.set.run(cacheKey, JSON.stringify(entry), cacheTtlModifier(RESOLVE_CACHE_TTL_MINUTES));
                    return entry;
                }
            }
            // Échec définitif : caché aussi (évite de marteler l'API à chaque partie)
            queries.cache.set.run(cacheKey, JSON.stringify(null), cacheTtlModifier(RESOLVE_CACHE_TTL_MINUTES));
            return null;
        } catch (error) {
            console.warn(`⚠️ Résolution IGDB échouée pour ${filterType}:${slug} — ${error.message}`);
            return null; // erreur réseau : pas de cache, on retentera
        }
    };
}

const resolveSlugDynamic = resolveSlugDynamicWith(igdbRequest);

/**
 * Met en forme un jeu IGDB brut pour l'API.
 */
function formatGame(game) {
    return {
        id: game.id,
        name: game.name,
        cover: game.cover ? game.cover.url.replace('t_thumb', 't_cover_big') : null,
        rating: Math.round(game.rating || 0),
        summary: game.summary ? game.summary.substring(0, 200) + '...' : null,
        genres: game.genres ? game.genres.map(g => g.name) : [],
        platforms: game.platforms ? game.platforms.map(p => p.name) : [],
        releaseYear: game.first_release_date
            ? new Date(game.first_release_date * 1000).getFullYear()
            : null
    };
}

/**
 * Recherche des jeux par filtres structurés
 */
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

/**
 * Recherche de jeux populaires (fallback)
 */
async function getPopularGames(limit = 10) {
    // Jeux populaires avec au moins quelques avis et une cover
    const body = `fields name, cover.url, rating, summary, genres.name, platforms.name, first_release_date; where rating != null & cover != null & rating_count > 5; sort rating desc; limit ${limit};`;

    console.log('📤 Requête jeux populaires');

    try {
        const games = await igdbRequest(ENDPOINTS.games, body);

        console.log('📥 IGDB:', games.length, 'jeux populaires trouvés');

        return games.map(formatGame);

    } catch (error) {
        console.error('❌ Erreur récupération jeux populaires:', error.message);
        return [];
    }
}

/**
 * Test de connexion à l'API IGDB
 */
async function testConnection() {
    try {
        await getAccessToken();
        const games = await getPopularGames(1);
        return games.length > 0;
    } catch (error) {
        return false;
    }
}

module.exports = {
    searchGamesByFilters,
    getPopularGames,
    testConnection,
    getAccessToken,
    resolveSlugDynamic,
    _test: { resolveSlugDynamicWith }
};
