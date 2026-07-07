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
            connectSrc: ["'self'", "https://api.igdb.com", "https://polygon-rpc.com", "https://polygon-mainnet.g.alchemy.com"],
            'report-uri': ['/api/csp-report'],
            'report-to': ['csp-endpoint']
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
 * Store optionnel Redis pour le rate-limiting multi-instance.
 * Sans REDIS_URL : store mémoire par défaut (mono-instance).
 */
function buildLimiterStore(prefix) {
    if (!process.env.REDIS_URL) return undefined;
    const { RedisStore } = require('rate-limit-redis');
    const Redis = require('ioredis');
    if (!global.__redisClient) {
        global.__redisClient = new Redis(process.env.REDIS_URL);
        console.log('✅ Rate-limiting adossé à Redis');
    }
    return new RedisStore({
        prefix: `rl:${prefix}:`,
        sendCommand: (...args) => global.__redisClient.call(...args)
    });
}

/**
 * Rate Limiter global
 */
const globalLimiter = rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.isTest ? 10000 : config.security.rateLimitMaxRequests,
    message: {
        success: false,
        error: 'Trop de requêtes, veuillez réessayer plus tard'
    },
    standardHeaders: true,
    legacyHeaders: false,
    store: buildLimiterStore('global')
});

/**
 * Rate Limiter strict pour la connexion (anti brute-force)
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: config.isTest ? 10000 : 10, // 10 tentatives max par IP
    message: {
        success: false,
        error: 'Trop de tentatives de connexion, réessayez dans 15 minutes'
    },
    store: buildLimiterStore('auth')
});

/**
 * Rate Limiter pour l'inscription (plus permissif)
 */
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 heure
    max: config.isTest ? 10000 : (config.isDev ? 50 : 10), // 50 en dev, 10 en prod
    message: {
        success: false,
        error: 'Trop de tentatives d\'inscription, réessayez dans une heure'
    },
    store: buildLimiterStore('register')
});

/**
 * Rate Limiter dédié à la vérification 2FA (anti brute-force sur 6 chiffres)
 */
const a2fLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.isTest ? 10000 : 5,
    message: {
        success: false,
        error: 'Trop de tentatives de vérification 2FA, réessayez dans 15 minutes'
    },
    store: buildLimiterStore('a2f')
});

/**
 * Rate Limiter pour les paiements crypto
 */
const paymentLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: config.isTest ? 10000 : 3, // 3 requêtes max
    message: {
        success: false,
        error: 'Veuillez patienter avant de soumettre un nouveau paiement'
    },
    store: buildLimiterStore('payment')
});

/**
 * Middleware d'authentification JWT
 */
const authenticateToken = (req, res, next) => {
    // Priorité au cookie httpOnly ; header Authorization conservé en compat
    const authHeader = req.headers['authorization'];
    const token = (req.cookies && req.cookies.access_token)
        || (authHeader && authHeader.split(' ')[1]);

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Token d\'authentification requis'
        });
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret, {
            algorithms: [config.jwt.algorithm]
        });

        if (decoded.pending2FA) {
            return res.status(401).json({
                success: false,
                error: 'Vérification 2FA requise'
            });
        }

        // Blacklist persistante (révocation au logout)
        const { isJtiRevoked } = require('../services/tokenService');
        if (isJtiRevoked(decoded.jti)) {
            return res.status(401).json({
                success: false,
                error: 'Token révoqué, veuillez vous reconnecter'
            });
        }

        // Invalidation globale au changement de mot de passe : tout access token
        // émis avant `password_changed_at` (secondes Unix) n'est plus honoré.
        // NB : granularité 1 s (iat en secondes) → un token émis dans la même
        // seconde que le changement survit (`<` strict). Compromis assumé qui
        // préserve la session courante ré-émise ; fenêtre ≤ 1 s vs TTL 15 min.
        // NB : ce findById ajoute un SELECT (PK indexée) par requête authentifiée.
        const account = queries.users.findById.get(decoded.id);
        if (!account) {
            return res.status(401).json({ success: false, error: 'Session invalide, veuillez vous reconnecter' });
        }
        if (account.password_changed_at && decoded.iat < account.password_changed_at) {
            return res.status(401).json({ success: false, error: 'Session expirée par changement de mot de passe' });
        }

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
    const token = (req.cookies && req.cookies.access_token)
        || (authHeader && authHeader.split(' ')[1]);

    if (token) {
        try {
            const decoded = jwt.verify(token, config.jwt.secret, {
                algorithms: [config.jwt.algorithm]
            });

            if (decoded.pending2FA) {
                return next();
            }

            // Blacklist persistante (révocation au logout) : un token révoqué
            // ne doit pas être honoré, mais optionalAuth ne bloque jamais la requête.
            const { isJtiRevoked } = require('../services/tokenService');
            if (!isJtiRevoked(decoded.jti)) {
                const account = queries.users.findById.get(decoded.id);
                if (account && !(account.password_changed_at && decoded.iat < account.password_changed_at)) {
                    req.user = decoded;
                }
            }
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

/**
 * En-têtes de sécurité additionnels (non couverts par Helmet)
 * Permissions-Policy : désactive les APIs sensibles non utilisées
 * Reporting-Endpoints : point de collecte des violations CSP (report-to)
 */
const extraHeaders = (req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Reporting-Endpoints', 'csp-endpoint="/api/csp-report"');
    next();
};

module.exports = {
    helmetConfig,
    globalLimiter,
    authLimiter,
    registerLimiter,
    a2fLimiter,
    paymentLimiter,
    authenticateToken,
    optionalAuth,
    requireAdmin,
    sanitizeInput,
    securityLogger,
    extraHeaders
};
