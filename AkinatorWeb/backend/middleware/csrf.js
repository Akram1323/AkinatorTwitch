/**
 * Middleware CSRF (Cross-Site Request Forgery) Protection
 * Génère et vérifie les tokens CSRF pour les requêtes mutantes
 * 
 * @author AkinatorTwitch Team
 * @version 1.0
 */

const crypto = require('crypto');
const { db } = require('../services/database');

// Durée de vie d'un token CSRF (1 heure)
const CSRF_TOKEN_EXPIRY_MINUTES = 60;

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Génère un token CSRF persisté en base (hashé)
 */
function generateCSRFToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`
        INSERT INTO csrf_tokens (user_id, token_hash, expires_at)
        VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))
    `).run(userId, sha256(token), CSRF_TOKEN_EXPIRY_MINUTES);

    // Nettoyer les tokens expirés
    cleanupExpiredTokens();

    return token;
}

/**
 * Vérifie un token CSRF
 */
function verifyCSRFToken(userId, token) {
    if (!token || !userId) {
        return false;
    }

    const row = db.prepare(`
        SELECT 1 FROM csrf_tokens
        WHERE user_id = ? AND token_hash = ? AND expires_at > datetime('now')
    `).get(userId, sha256(token));

    return !!row;
}

/**
 * Purge les tokens expirés
 */
function cleanupExpiredTokens() {
    db.prepare(`DELETE FROM csrf_tokens WHERE expires_at <= datetime('now')`).run();
}

/**
 * Middleware CSRF pour les routes mutantes (POST, PUT, DELETE)
 */
const csrfProtection = (req, res, next) => {
    // Ignorer les méthodes GET, HEAD, OPTIONS
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }
    
    // Vérifier si l'utilisateur est authentifié
    if (!req.user || !req.user.id) {
        return next(); // Pas de CSRF si pas authentifié (géré par authenticateToken)
    }
    
    // Récupérer le token depuis le header
    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    
    if (!csrfToken) {
        return res.status(403).json({
            success: false,
            error: 'Token CSRF manquant'
        });
    }
    
    // Vérifier le token
    if (!verifyCSRFToken(req.user.id, csrfToken)) {
        return res.status(403).json({
            success: false,
            error: 'Token CSRF invalide ou expiré'
        });
    }
    
    next();
};

/**
 * Route pour obtenir un token CSRF
 */
const getCSRFToken = (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({
            success: false,
            error: 'Authentification requise'
        });
    }
    
    const token = generateCSRFToken(req.user.id);
    
    res.json({
        success: true,
        data: {
            csrfToken: token
        }
    });
};

module.exports = {
    csrfProtection,
    generateCSRFToken,
    verifyCSRFToken,
    getCSRFToken,
    cleanupExpiredTokens
};
