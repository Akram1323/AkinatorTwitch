/**
 * Service IGDB - Proxy sécurisé pour l'API IGDB/Twitch
 * Cache les credentials et valide les données
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const config = require('../config/config');
const { cache } = require('./database');

// Cache du token en mémoire
let accessToken = null;
let tokenExpiresAt = 0;

/**
 * Récupère un token OAuth valide
 */
async function getAccessToken() {
    const now = Date.now();
    
    // Retourner le token en cache s'il est encore valide
    if (accessToken && tokenExpiresAt > now + 60000) {
        return accessToken;
    }

    console.log('🔑 Demande d\'un nouveau token IGDB...');

    const url = `${config.twitch.tokenUrl}?client_id=${config.twitch.clientId}&client_secret=${config.twitch.clientSecret}&grant_type=client_credentials`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!response.ok) {
        throw new Error(`Erreur OAuth: ${response.status}`);
    }

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiresAt = now + (data.expires_in * 1000);

    console.log('✅ Token IGDB obtenu');
    return accessToken;
}

/**
 * Effectue une requête à l'API IGDB
 */
async function igdbRequest(endpoint, body) {
    const token = await getAccessToken();
    
    const response = await fetch(`${config.twitch.igdbUrl}/${endpoint}`, {
        method: 'POST',
        headers: {
            'Client-ID': config.twitch.clientId,
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'text/plain'
        },
        body
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Erreur IGDB: ${response.status} - ${error}`);
    }

    return response.json();
}

/**
 * Recherche l'ID d'un filtre (genre, plateforme, etc.)
 */
async function getFilterId(endpoint, field, value) {
    const cacheKey = `filter_${endpoint}_${field}_${value}`;
    
    // Vérifier le cache
    const cached = cache.get.get(cacheKey);
    if (cached) {
        return JSON.parse(cached.data);
    }

    const body = `fields id,${field}; where ${field} ~ *"${value}"*; limit 1;`;
    const results = await igdbRequest(endpoint, body);

    if (results.length > 0) {
        cache.set.run(cacheKey, JSON.stringify(results[0].id));
        return results[0].id;
    }

    return null;
}

/**
 * Recherche des jeux par filtres
 */
async function searchGames(filters) {
    const cacheKey = `games_${JSON.stringify(filters)}`;
    
    // Vérifier le cache
    const cached = cache.get.get(cacheKey);
    if (cached) {
        console.log('📦 Résultats depuis le cache');
        return JSON.parse(cached.data);
    }

    // Construire les conditions de recherche
    const conditions = ['category = 0']; // Jeux principaux uniquement
    
    // Genres
    if (filters.genres && filters.genres.length > 0) {
        const genreIds = [];
        for (const genre of filters.genres) {
            const id = await getFilterId('genres', 'slug', genre);
            if (id) genreIds.push(id);
        }
        if (genreIds.length > 0) {
            conditions.push(`genres = (${genreIds.join(',')})`);
        }
    }

    // Plateformes
    if (filters.platforms && filters.platforms.length > 0) {
        const platformIds = [];
        for (const platform of filters.platforms) {
            const id = await getFilterId('platforms', 'slug', platform);
            if (id) platformIds.push(id);
        }
        if (platformIds.length > 0) {
            conditions.push(`platforms = (${platformIds.join(',')})`);
        }
    }

    // Thèmes
    if (filters.themes && filters.themes.length > 0) {
        const themeIds = [];
        for (const theme of filters.themes) {
            const id = await getFilterId('themes', 'slug', theme);
            if (id) themeIds.push(id);
        }
        if (themeIds.length > 0) {
            conditions.push(`themes = (${themeIds.join(',')})`);
        }
    }

    // Modes de jeu
    if (filters.gameModes && filters.gameModes.length > 0) {
        const modeIds = [];
        for (const mode of filters.gameModes) {
            const id = await getFilterId('game_modes', 'slug', mode);
            if (id) modeIds.push(id);
        }
        if (modeIds.length > 0) {
            conditions.push(`game_modes = (${modeIds.join(',')})`);
        }
    }

    // Note minimale (jeux populaires/bien notés)
    conditions.push('rating > 60');
    conditions.push('rating_count > 10');

    const body = `
        fields name, cover.url, rating, summary, genres.name, platforms.name, first_release_date;
        where ${conditions.join(' & ')};
        sort rating desc;
        limit 10;
    `;

    console.log('🎮 Requête IGDB:', body.replace(/\s+/g, ' ').trim());

    const results = await igdbRequest('games', body);

    // Formater les résultats
    const games = results.map(game => ({
        id: game.id,
        name: game.name,
        cover: game.cover ? game.cover.url.replace('t_thumb', 't_cover_big') : null,
        rating: Math.round(game.rating || 0),
        summary: game.summary?.slice(0, 200) || '',
        genres: game.genres?.map(g => g.name) || [],
        platforms: game.platforms?.map(p => p.name) || [],
        releaseYear: game.first_release_date 
            ? new Date(game.first_release_date * 1000).getFullYear() 
            : null
    }));

    // Mettre en cache
    cache.set.run(cacheKey, JSON.stringify(games));

    return games;
}

/**
 * Récupère les genres populaires
 */
async function getPopularGenres() {
    const cacheKey = 'popular_genres';
    
    const cached = cache.get.get(cacheKey);
    if (cached) {
        return JSON.parse(cached.data);
    }

    const body = 'fields name, slug; sort name asc; limit 20;';
    const results = await igdbRequest('genres', body);

    cache.set.run(cacheKey, JSON.stringify(results));
    return results;
}

/**
 * Récupère les plateformes populaires
 */
async function getPopularPlatforms() {
    const cacheKey = 'popular_platforms';
    
    const cached = cache.get.get(cacheKey);
    if (cached) {
        return JSON.parse(cached.data);
    }

    // Plateformes principales
    const body = `
        fields name, slug; 
        where id = (6, 48, 49, 130, 167, 169); 
        sort name asc;
    `;
    // 6=PC, 48=PS4, 49=Xbox One, 130=Switch, 167=PS5, 169=Xbox Series

    const results = await igdbRequest('platforms', body);

    cache.set.run(cacheKey, JSON.stringify(results));
    return results;
}

module.exports = {
    getAccessToken,
    searchGames,
    getFilterId,
    getPopularGenres,
    getPopularPlatforms
};
