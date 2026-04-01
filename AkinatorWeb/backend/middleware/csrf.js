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
const CSRF_TOKEN_EXPIRY = 60 * 60 * 1000;

/**
 * Génère un token CSRF et le stocke en session
 */
function generateCSRFToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + CSRF_TOKEN_EXPIRY;
    
    // Stocker le token (en mémoire pour simplifier, utiliser Redis en production)
    if (!global.csrfTokens) {
        global.csrfTokens = new Map();
    }
    
    global.csrfTokens.set(`${userId}:${token}`, expiresAt);
    
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
    
    if (!global.csrfTokens) {
        return false;
    }
    
    const key = `${userId}:${token}`;
    const expiresAt = global.csrfTokens.get(key);
    
    if (!expiresAt) {
        return false;
    }
    
    if (Date.now() > expiresAt) {
        global.csrfTokens.delete(key);
        return false;
    }
    
    return true;
}

/**
 * Nettoie les tokens expirés
 */
function cleanupExpiredTokens() {
    if (!global.csrfTokens) return;
    
    const now = Date.now();
    for (const [key, expiresAt] of global.csrfTokens.entries()) {
        if (now > expiresAt) {
            global.csrfTokens.delete(key);
        }
    }
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
    getCSRFToken
};
