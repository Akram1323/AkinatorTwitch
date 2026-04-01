/**
 * Middleware de sécurité
 * Protection contre les attaques courantes
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { queries } = require('../services/database');
const { hashIPForLogging } = require('../services/encryption');

/**
 * Configuration Helmet (headers de sécurité)
 */
const helmetConfig = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Pas de 'unsafe-inline' pour les scripts = plus sécurisé (utilise addEventListener)
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://images.igdb.com", "https:"],
            connectSrc: ["'self'", "https://api.igdb.com", "https://polygon-rpc.com", "https://polygon-mainnet.g.alchemy.com"]
        }
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: {
        maxAge: 31536000, // 1 an
        includeSubDomains: true,
        preload: true
    }
});

/**
 * Rate Limiter global
 */
const globalLimiter = rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMaxRequests,
    message: {
        success: false,
        error: 'Trop de requêtes, veuillez réessayer plus tard'
    },
    standardHeaders: true,
    legacyHeaders: false
});

/**
 * Rate Limiter strict pour la connexion (anti brute-force)
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 tentatives max par IP
    message: {
        success: false,
        error: 'Trop de tentatives de connexion, réessayez dans 15 minutes'
    }
});

/**
 * Rate Limiter pour l'inscription (plus permissif)
 */
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 heure
    max: config.isDev ? 50 : 10, // 50 en dev, 10 en prod
    message: {
        success: false,
        error: 'Trop de tentatives d\'inscription, réessayez dans une heure'
    }
});

/**
 * Rate Limiter pour les paiements crypto
 */
const paymentLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 3, // 3 requêtes max
    message: {
        success: false,
        error: 'Veuillez patienter avant de soumettre un nouveau paiement'
    }
});

/**
 * Middleware d'authentification JWT
 */
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Token d\'authentification requis'
        });
    }

    // Vérifier si le token est révoqué (blacklist)
    try {
        const { tokenBlacklist } = require('../routes/auth');
        if (tokenBlacklist && tokenBlacklist.has(token)) {
            return res.status(401).json({
                success: false,
                error: 'Token révoqué, veuillez vous reconnecter'
            });
        }
    } catch (e) { /* module pas encore chargé, on continue */ }

    try {
        const decoded = jwt.verify(token, config.jwt.secret, {
            algorithms: [config.jwt.algorithm]
        });
        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Token expiré, veuillez vous reconnecter'
            });
        }
        return res.status(403).json({
            success: false,
            error: 'Token invalide'
        });
    }
};

/**
 * Middleware optionnel d'authentification (ne bloque pas si pas de token)
 */
const optionalAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        try {
            req.user = jwt.verify(token, config.jwt.secret);
        } catch (err) {
            // Token invalide, on continue sans user
        }
    }
    next();
};

/**
 * Middleware de vérification admin
 * Doit être utilisé APRÈS authenticateToken
 */
const requireAdmin = async (req, res, next) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({
            success: false,
            error: 'Authentification requise'
        });
    }

    try {
        const user = queries.users.findById.get(req.user.id);
        
        if (!user || !user.is_admin || user.is_admin === 0) {
            return res.status(403).json({
                success: false,
                error: 'Accès administrateur requis'
            });
        }

        req.adminUser = user;
        next();
    } catch (error) {
        console.error('❌ Erreur vérification admin:', error);
        return res.status(500).json({
            success: false,
            error: 'Erreur lors de la vérification des droits'
        });
    }
};

/**
 * Validation et sanitization des entrées
 */
const sanitizeInput = (req, res, next) => {
    // Nettoyer les paramètres de requête
    const sanitize = (obj) => {
        if (typeof obj === 'string') {
            // Supprimer les caractères dangereux
            return obj
                .replace(/<[^>]*>/g, '') // HTML tags
                .replace(/javascript:/gi, '')
                .replace(/on\w+=/gi, '')
                .trim()
                .slice(0, 1000); // Limiter la longueur
        }
        if (typeof obj === 'object' && obj !== null) {
            for (const key in obj) {
                obj[key] = sanitize(obj[key]);
            }
        }
        return obj;
    };

    req.body = sanitize(req.body);
    req.query = sanitize(req.query);
    req.params = sanitize(req.params);
    
    next();
};

/**
 * Logger de sécurité
 */
const securityLogger = (req, res, next) => {
    const rawIP = req.ip || req.connection.remoteAddress;
    // Hasher l'IP pour les logs (conformité RGPD)
    const hashedIP = hashIPForLogging(rawIP);
    
    const logData = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        ip: hashedIP, // IP hashée pour conformité RGPD
        userAgent: req.get('User-Agent')?.slice(0, 100),
        userId: req.user?.id || 'anonymous'
    };

    // Log en mode dev
    if (config.isDev) {
        console.log(`[${logData.timestamp}] ${logData.method} ${logData.path} - IP:${hashedIP}`);
    }

    // Détecter les comportements suspects
    const suspiciousPatterns = [
        /\.\.\//,           // Path traversal
        /<script/i,         // XSS
        /union.*select/i,   // SQL injection
        /eval\(/i,          // Code injection
    ];

    const fullUrl = req.originalUrl;
    for (const pattern of suspiciousPatterns) {
        if (pattern.test(fullUrl) || pattern.test(JSON.stringify(req.body))) {
            console.warn(`⚠️ SECURITY: Requête suspecte détectée - ${logData.ip} - ${fullUrl}`);
            return res.status(400).json({
                success: false,
                error: 'Requête invalide'
            });
        }
    }

    next();
};

module.exports = {
    helmetConfig,
    globalLimiter,
    authLimiter,
    registerLimiter,
    paymentLimiter,
    authenticateToken,
    optionalAuth,
    requireAdmin,
    sanitizeInput,
    securityLogger
};
