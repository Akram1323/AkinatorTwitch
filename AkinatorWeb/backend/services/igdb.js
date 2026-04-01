/**
 * Service IGDB (Internet Game Database)
 * Intégration avec l'API Twitch/IGDB pour la recommandation de jeux
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

// Cache des filtres IGDB (pour éviter les requêtes répétées)
const filterCache = new Map();
const FILTER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 heures

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

/**
 * Normalise une chaîne en slug IGDB
 */
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

/**
 * Recherche l'ID d'un filtre (genre, plateforme, thème, mode de jeu)
 */
async function fetchFilterId(endpoint, field, value) {
    if (!value || !value.trim()) return -1;

    // Vérifier le cache
    const cacheKey = `${endpoint}:${field}:${value}`;
    const cached = filterCache.get(cacheKey);
    if (cached && cached.timestamp > Date.now() - FILTER_CACHE_TTL) {
        return cached.id;
    }

    const sanitizedValue = value.replace(/["\\;']/g, '').trim();
    const body = `fields id,${field}; where ${field}="${sanitizedValue}"; limit 1;`;

    try {
        const results = await igdbRequest(endpoint, body);
        
        if (results && results.length > 0) {
            const id = results[0].id;
            filterCache.set(cacheKey, { id, timestamp: Date.now() });
            return id;
        }
    } catch (error) {
        console.warn(`⚠️ Filtre non trouvé: ${field}=${value}`);
    }

    return -1;
}

/**
 * Mapping des filtres de l'arbre de décision vers les IDs IGDB
 * https://api-docs.igdb.com/#genre
 * 
 * Genres IGDB disponibles:
 * 2=Point-and-click, 4=Fighting, 5=Shooter, 7=Music, 8=Platform
 * 9=Puzzle, 10=Racing, 11=RTS, 12=RPG, 13=Simulator, 14=Sport
 * 15=Strategy, 16=TBS, 24=Tactical, 25=Hack and slash, 26=Quiz
 * 30=Pinball, 31=Adventure, 32=Indie, 33=Arcade, 34=Visual Novel
 * 35=Card & Board Game, 36=MOBA
 */
const FILTER_MAPPINGS = {
    // Genres - IDs fixes IGDB
    genres: {
        'action': 25,           // Hack and slash/Beat 'em up (le plus proche d'"action")
        'aventure': 31,         // Adventure
        'adventure': 31,
        'rpg': 12,              // Role-playing (RPG)
        'role-playing': 12,
        'role-playing-rpg': 12,
        'fps': 5,               // Shooter
        'shooter': 5,
        'fps-shooter': 5,
        'tir': 5,
        'sport': 14,            // Sport
        'strategie': 15,        // Strategy
        'strategy': 15,
        'rts': 11,              // Real Time Strategy (RTS)
        'tbs': 16,              // Turn-based strategy (TBS)
        'simulation': 13,       // Simulator
        'simulator': 13,
        'puzzle': 9,            // Puzzle
        'horreur': 31,          // Adventure (pas de genre horror, utiliser thème)
        'horror': 31,
        'indie': 32,            // Indie
        'plateforme': 8,        // Platform
        'platform': 8,
        'course': 10,           // Racing
        'racing': 10,
        'combat': 4,            // Fighting
        'fighting': 4,
        'arcade': 33,           // Arcade
        'moba': 36,             // MOBA
        'tactique': 24,         // Tactical
        'tactical': 24,
        'visual-novel': 34,     // Visual Novel
        'point-and-click': 2    // Point-and-click
    },
    // Plateformes - IDs fixes IGDB
    platforms: {
        'pc': 6,           // PC (Windows)
        'win': 6,
        'windows': 6,
        'playstation': 48, // PS4
        'ps4': 48,
        'ps5': 167,
        'playstation-5': 167,
        'playstation-4': 48,
        'xbox': 49,        // Xbox One
        'xbox-one': 49,
        'xbox-series': 169,
        'xbox-series-x': 169,
        'switch': 130,     // Nintendo Switch
        'nintendo-switch': 130,
        'mobile': 34,      // Android
        'android': 34,
        'ios': 39
    },
    // Thèmes - IDs fixes IGDB
    themes: {
        'science-fiction': 18,
        'sci-fi': 18,
        'fantasy': 17,
        'guerre': 39,
        'warfare': 39,
        'war': 39,
        'survie': 21,
        'survival': 21,
        'open-world': 38,
        'monde-ouvert': 38,
        'horreur': 19,
        'horror': 19,
        'action': 1,
        'drame': 31,
        'drama': 31,
        'historique': 22,
        'historical': 22
    },
    // Modes de jeu - IDs fixes IGDB
    gameModes: {
        'solo': 1,                  // Single player
        'single-player': 1,
        'joueur-unique': 1,
        'multijoueur': 2,           // Multiplayer
        'multiplayer': 2,
        'coop': 3,                  // Co-operative
        'co-operative': 3,
        'cooperative': 3,
        'local-coop': 4,            // Local co-op
        'battle-royale': 5,         // Battle Royale
        'mmo': 5                    // MMO
    }
};

/**
 * Recherche des jeux par filtres structurés
 */
async function searchGamesByFilters(filters) {
    if (!filters || filters.length === 0) {
        console.log('⚠️ Aucun filtre fourni pour la recherche');
        return getPopularGames(15);
    }

    console.log('🔍 Recherche IGDB avec filtres:', filters.map(f => f.text || f.slug));

    // Collecter les IDs de filtres (utilisation directe des IDs mappés)
    const genreIds = [];
    const platformIds = [];
    const themeIds = [];
    const gameModeIds = [];

    for (const filter of filters) {
        const filterType = filter.filterType || filter.filter_type;
        const slug = normalizeSlug(filter.slug || filter.text);
        
        console.log(`  📎 Filtre: ${filterType} = ${slug}`);
        
        switch (filterType) {
            case 'genre':
                // Utiliser directement l'ID mappé
                const genreId = FILTER_MAPPINGS.genres[slug];
                if (genreId) {
                    genreIds.push(genreId);
                    console.log(`    ✓ Genre ID: ${genreId}`);
                }
                break;

            case 'platform':
                const platformId = FILTER_MAPPINGS.platforms[slug];
                if (platformId) {
                    platformIds.push(platformId);
                    console.log(`    ✓ Platform ID: ${platformId}`);
                }
                break;

            case 'theme':
                const themeId = FILTER_MAPPINGS.themes[slug];
                if (themeId) {
                    themeIds.push(themeId);
                    console.log(`    ✓ Theme ID: ${themeId}`);
                }
                break;

            case 'game_mode':
                const gameModeId = FILTER_MAPPINGS.gameModes[slug];
                if (gameModeId) {
                    gameModeIds.push(gameModeId);
                    console.log(`    ✓ Game Mode ID: ${gameModeId}`);
                }
                break;
        }
    }

    // Construire la requête IGDB
    const conditions = [];
    
    if (genreIds.length > 0) {
        conditions.push(`genres = (${genreIds.join(',')})`);
    }
    if (platformIds.length > 0) {
        conditions.push(`platforms = (${platformIds.join(',')})`);
    }
    if (themeIds.length > 0) {
        conditions.push(`themes = (${themeIds.join(',')})`);
    }
    if (gameModeIds.length > 0) {
        conditions.push(`game_modes = (${gameModeIds.join(',')})`);
    }
    
    // Filtres de base pour avoir des résultats de qualité
    conditions.push('cover != null');  // Jeux avec cover uniquement

    const whereClause = conditions.length > 0 
        ? `where ${conditions.join(' & ')}`
        : '';

    const body = `fields name, cover.url, rating, summary, genres.name, platforms.name, first_release_date; ${whereClause}; sort rating desc; limit 15;`;

    console.log('📤 Requête IGDB:', body);

    try {
        const games = await igdbRequest(ENDPOINTS.games, body);
        
        // Formater les résultats
        const formattedGames = games.map(game => ({
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
        }));

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
    const body = `fields name, cover.url, rating, summary, genres.name, first_release_date; where rating != null & cover != null & rating_count > 5; sort rating desc; limit ${limit};`;

    console.log('📤 Requête jeux populaires');

    try {
        const games = await igdbRequest(ENDPOINTS.games, body);
        
        console.log('📥 IGDB:', games.length, 'jeux populaires trouvés');
        
        return games.map(game => ({
            id: game.id,
            name: game.name,
            cover: game.cover ? game.cover.url.replace('t_thumb', 't_cover_big') : null,
            rating: Math.round(game.rating || 0),
            summary: game.summary ? game.summary.substring(0, 200) + '...' : null,
            genres: game.genres ? game.genres.map(g => g.name) : [],
            releaseYear: game.first_release_date 
                ? new Date(game.first_release_date * 1000).getFullYear() 
                : null
        }));

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
    getAccessToken
};
