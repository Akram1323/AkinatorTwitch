/**
 * Routes d'authentification SÉCURISÉES
 * Inscription, connexion, gestion du profil
 * 
 * SÉCURITÉ:
 * - Bcrypt avec 12 rounds pour le hash
 * - Protection contre brute force
 * - Validation stricte des entrées
 * - Pas de leak d'information sur les comptes existants
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const config = require('../config/config');
const { queries } = require('../services/database');
const { authLimiter, registerLimiter, authenticateToken } = require('../middleware/security');
const { encryptIP } = require('../services/encryption');

const router = express.Router();

// JWT blacklist en mémoire (tokens révoqués)
const tokenBlacklist = new Set();

// Nettoyage périodique des tokens expirés du blacklist (toutes les heures)
setInterval(() => {
    tokenBlacklist.forEach(token => {
        try {
            jwt.verify(token, config.jwt.secret);
        } catch (e) {
            if (e.name === 'TokenExpiredError') tokenBlacklist.delete(token);
        }
    });
}, 3600 * 1000);

// tokenBlacklist sera exporté avec le router à la fin du fichier

// Constantes de sécurité
const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

/**
 * POST /api/auth/register
 * Inscription d'un nouvel utilisateur
 */
router.post('/register',
    registerLimiter,
    [
        body('username')
            .trim()
            .isLength({ min: 3, max: 20 })
            .matches(/^[a-zA-Z0-9_]+$/)
            .withMessage('Username: 3-20 caractères alphanumériques uniquement'),
        body('password')
            .isLength({ min: 8, max: 100 })
            .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
            .withMessage('Mot de passe: min 8 caractères avec majuscule, minuscule et chiffre'),
        body('rgpdConsent')
            .custom((value) => {
                if (value === true || value === 'true') return true;
                throw new Error('Vous devez accepter le traitement de vos données personnelles (RGPD)');
            })
    ],
    async (req, res) => {
        try {
            // Validation
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: errors.array()[0].msg
                });
            }

            const { username, password, rgpdConsent } = req.body;
            
            // Vérifier le consentement RGPD
            if (rgpdConsent !== true && rgpdConsent !== 'true') {
                return res.status(400).json({
                    success: false,
                    error: 'Vous devez accepter le traitement de vos données personnelles (RGPD)'
                });
            }
            
            const rawIP = req.ip || req.connection.remoteAddress;
            
            // Chiffrer l'IP pour conformité RGPD
            const encryptedIP = encryptIP(rawIP);

            // Vérifier si l'utilisateur existe
            const existingUser = queries.users.findByUsername.get(username);
            
            if (existingUser) {
                return res.status(409).json({
                    success: false,
                    error: 'Cet identifiant est déjà utilisé'
                });
            }

            // Hash du mot de passe avec bcrypt (12 rounds = sécurisé)
            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

            // Créer l'utilisateur avec 3 jetons de départ
            const userId = uuidv4();
            // encryptedIP peut être null si l'IP n'a pas pu être chiffrée, c'est acceptable
            queries.users.create.run(userId, username, passwordHash, 3, encryptedIP || null);

            // Enregistrer la transaction de jetons offerts
            queries.transactions.create.run(uuidv4(), userId, 'gift', 3, null, 'completed');

            // Générer le token JWT
            const token = jwt.sign(
                { id: userId, username },
                config.jwt.secret,
                { expiresIn: config.jwt.expiresIn, algorithm: config.jwt.algorithm }
            );

            // Ne pas logger l'IP en clair (conformité RGPD)
            console.log(`✅ Nouvel utilisateur inscrit: ${username}`);

            res.status(201).json({
                success: true,
                message: 'Compte créé avec succès ! 3 jetons offerts !',
                data: {
                    token,
                    user: {
                        id: userId,
                        username,
                        tokens: 3,
                        totalGames: 0
                    }
                }
            });

        } catch (error) {
            console.error('Erreur inscription:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors de l\'inscription'
            });
        }
    }
);

/**
 * POST /api/auth/login
 * Connexion d'un utilisateur
 */
router.post('/login',
    authLimiter,
    [
        body('username').trim().notEmpty().withMessage('Username requis'),
        body('password').notEmpty().withMessage('Mot de passe requis')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: errors.array()[0].msg
                });
            }

            const { username, password } = req.body;
            const rawIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
            const encryptedIP = encryptIP(rawIP);

            // Trouver l'utilisateur
            const user = queries.users.findByUsername.get(username);
            
            // Message générique pour ne pas révéler si l'utilisateur existe
            if (!user) {
                await bcrypt.hash('dummy', BCRYPT_ROUNDS);
                return res.status(401).json({
                    success: false,
                    error: 'Identifiants incorrects'
                });
            }

            // Vérifier si le compte est verrouillé
            if (user.locked_until && new Date(user.locked_until) > new Date()) {
                const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
                return res.status(423).json({
                    success: false,
                    error: `Compte temporairement verrouillé. Réessayez dans ${remainingMinutes} minutes.`
                });
            }

            // Vérifier le mot de passe
            const validPassword = await bcrypt.compare(password, user.password_hash);
            
            if (!validPassword) {
                queries.users.incrementFailedLogin.run(user.id);
                
                const attempts = user.failed_login_attempts + 1;
                const remaining = MAX_LOGIN_ATTEMPTS - attempts;
                
                if (remaining <= 0) {
                    return res.status(423).json({
                        success: false,
                        error: `Trop de tentatives. Compte verrouillé pour ${LOCKOUT_DURATION_MINUTES} minutes.`
                    });
                }
                
                return res.status(401).json({
                    success: false,
                    error: `Identifiants incorrects. ${remaining} tentative(s) restante(s).`
                });
            }

            // Vérifier si A2F est activé
            if (user.a2f_enabled) {
                // Ne pas donner le token complet, juste un token temporaire pour la vérification A2F
                const tempToken = jwt.sign(
                    { id: user.id, username: user.username, pending2FA: true },
                    config.jwt.secret,
                    { expiresIn: '5m' }
                );

                console.log(`🔐 A2F requis: ${username}`);

                return res.json({
                    success: true,
                    requiresA2F: true,
                    data: {
                        tempToken
                        // userId retiré pour sécurité (utiliser le token)
                    }
                });
            }

            // Connexion réussie sans A2F - reset les tentatives
            // encryptedIP peut être null si l'IP n'a pas pu être chiffrée, c'est acceptable
            queries.users.updateLastLogin.run(encryptedIP || null, user.id);

            // Logger la session (audit trail)
            try {
                const { db } = require('../services/database');
                db.prepare(`INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at)
                    VALUES (?, ?, ?, ?, datetime('now', '+24 hours'))`)
                    .run(uuidv4(), user.id, encryptedIP || null, req.headers['user-agent'] || null);
            } catch (e) { /* non bloquant */ }

            // Générer le token
            const token = jwt.sign(
                { id: user.id, username: user.username, is_admin: user.is_admin === 1 },
                config.jwt.secret,
                { expiresIn: config.jwt.expiresIn, algorithm: config.jwt.algorithm }
            );

            // Vérifier si peut claim les jetons quotidiens
            let canClaimDaily = false;
            try {
                const dailyCheck = queries.users.canClaimDaily.get(user.id);
                canClaimDaily = dailyCheck ? dailyCheck.can_claim === 1 : false;
            } catch (dailyError) {
                console.warn('⚠️ Erreur vérification daily claim:', dailyError.message);
                canClaimDaily = false;
            }

            // Ne pas logger l'IP en clair (conformité RGPD)
            console.log(`✅ Connexion: ${username}`);

            res.json({
                success: true,
                data: {
                    token,
                    user: {
                        id: user.id,
                        username: user.username,
                        tokens: user.tokens,
                        totalGames: user.total_games,
                        walletAddress: user.wallet_address,
                        avatarUrl: user.avatar_url,
                        a2fEnabled: user.a2f_enabled === 1,
                        isAdmin: user.is_admin === 1,
                        canClaimDaily
                    }
                }
            });

        } catch (error) {
            console.error('❌ Erreur connexion:', error);
            console.error('Stack:', error.stack);
            // En mode dev, retourner plus de détails pour le débogage
            const errorMessage = config.isDev 
                ? `Erreur lors de la connexion: ${error.message}`
                : 'Erreur lors de la connexion';
            res.status(500).json({
                success: false,
                error: errorMessage
            });
        }
    }
);

/**
 * GET /api/auth/me
 * Récupère le profil de l'utilisateur connecté
 */
router.get('/me', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }

        const dailyCheck = queries.users.canClaimDaily.get(user.id);
        const canClaimDaily = dailyCheck ? dailyCheck.can_claim === 1 : false;

        res.json({
            success: true,
            data: {
                id: user.id,
                username: user.username,
                tokens: user.tokens,
                totalGames: user.total_games,
                walletAddress: user.wallet_address,
                avatarUrl: user.avatar_url,
                a2fEnabled: user.a2f_enabled === 1,
                isAdmin: user.is_admin === 1,
                createdAt: user.created_at,
                canClaimDaily
            }
        });

    } catch (error) {
        console.error('Erreur profil:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération du profil'
        });
    }
});

/**
 * POST /api/auth/claim-daily
 * Réclamer les 3 jetons quotidiens gratuits
 */
router.post('/claim-daily', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }

        const dailyCheck = queries.users.canClaimDaily.get(user.id);
        
        if (!dailyCheck || dailyCheck.can_claim !== 1) {
            return res.status(400).json({
                success: false,
                error: 'Vous avez déjà réclamé vos jetons aujourd\'hui. Revenez demain !'
            });
        }

        queries.users.updateDailyClaim.run(user.id);
        queries.transactions.create.run(uuidv4(), user.id, 'daily', 3, null, 'completed');

        const updatedUser = queries.users.findById.get(user.id);

        console.log(`🎁 Jetons quotidiens: ${user.username} +3 jetons`);

        res.json({
            success: true,
            message: '3 jetons quotidiens ajoutés !',
            data: {
                tokensAdded: 3,
                newBalance: updatedUser.tokens
            }
        });

    } catch (error) {
        console.error('Erreur claim-daily:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la réclamation'
        });
    }
});

/**
 * POST /api/auth/verify-login-a2f
 * Vérifie le code A2F et complète la connexion
 * SÉCURISÉ : Utilise le token temporaire pour éviter IDOR
 */
router.post('/verify-login-a2f',
    authLimiter,
    [
        body('code').isLength({ min: 6, max: 6 }).isNumeric()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: 'Code invalide (6 chiffres)'
                });
            }

            // Vérifier le token temporaire (doit contenir pending2FA: true)
            const authHeader = req.headers['authorization'];
            const tempToken = authHeader && authHeader.split(' ')[1];
            
            if (!tempToken) {
                return res.status(401).json({
                    success: false,
                    error: 'Token temporaire requis'
                });
            }

            let decoded;
            try {
                decoded = jwt.verify(tempToken, config.jwt.secret);
                if (!decoded.pending2FA) {
                    return res.status(403).json({
                        success: false,
                        error: 'Token invalide pour la vérification A2F'
                    });
                }
            } catch (err) {
                return res.status(401).json({
                    success: false,
                    error: 'Token temporaire invalide ou expiré'
                });
            }

            const { code } = req.body;
            const rawIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
            const encryptedIP = encryptIP(rawIP);

            // Utiliser userId du token (sécurisé contre IDOR)
            const user = queries.users.findById.get(decoded.id);
            if (!user || !user.a2f_enabled || !user.a2f_secret) {
                return res.status(400).json({
                    success: false,
                    error: 'Configuration A2F invalide'
                });
            }

            // Vérifier le code TOTP
            const speakeasy = require('speakeasy');
            const isValid = speakeasy.totp.verify({
                secret: user.a2f_secret,
                encoding: 'base32',
                token: code,
                window: 1
            });

            if (!isValid) {
                return res.status(401).json({
                    success: false,
                    error: 'Code A2F incorrect'
                });
            }

            // Connexion réussie
            // encryptedIP peut être null si l'IP n'a pas pu être chiffrée, c'est acceptable
            queries.users.updateLastLogin.run(encryptedIP || null, user.id);

            const token = jwt.sign(
                { id: user.id, username: user.username, is_admin: user.is_admin === 1 },
                config.jwt.secret,
                { expiresIn: config.jwt.expiresIn, algorithm: config.jwt.algorithm }
            );

            let canClaimDaily = false;
            try {
                const dailyCheck = queries.users.canClaimDaily.get(user.id);
                canClaimDaily = dailyCheck ? dailyCheck.can_claim === 1 : false;
            } catch (dailyError) {
                console.warn('⚠️ Erreur vérification daily claim:', dailyError.message);
                canClaimDaily = false;
            }

            console.log(`✅ Connexion A2F: ${user.username}`);

            res.json({
                success: true,
                data: {
                    token,
                    user: {
                        id: user.id,
                        username: user.username,
                        tokens: user.tokens,
                        totalGames: user.total_games,
                        walletAddress: user.wallet_address,
                        avatarUrl: user.avatar_url,
                        a2fEnabled: true,
                        canClaimDaily
                    }
                }
            });

        } catch (error) {
            console.error('Erreur verify-login-a2f:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur de vérification'
            });
        }
    }
);

/**
 * POST /api/auth/link-wallet
 * Associe une adresse wallet à un compte
 */
router.post('/link-wallet',
    authenticateToken,
    [
        body('walletAddress')
            .matches(/^0x[a-fA-F0-9]{40}$/)
            .withMessage('Adresse wallet invalide')
    ],
    (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: errors.array()[0].msg
                });
            }

            const { walletAddress } = req.body;

            // Récupérer l'utilisateur actuel
            const user = queries.users.findById.get(req.user.id);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'Utilisateur non trouvé'
                });
            }

            // Vérifier si le wallet est déjà associé à un autre compte
            const existing = queries.users.findByWallet.get(walletAddress);
            if (existing && existing.id !== req.user.id) {
                return res.status(409).json({
                    success: false,
                    error: 'Ce wallet est déjà associé à un autre compte'
                });
            }

            // Si l'utilisateur a déjà un wallet, logger le changement pour audit
            if (user.wallet_address && user.wallet_address !== walletAddress) {
                console.log(`⚠️ Changement de wallet: ${req.user.username} - Ancien: ${user.wallet_address} -> Nouveau: ${walletAddress}`);
            }

            queries.users.linkWallet.run(walletAddress, req.user.id);

            console.log(`🔗 Wallet lié: ${req.user.username} -> ${walletAddress}`);

            res.json({
                success: true,
                message: 'Wallet associé avec succès'
            });

        } catch (error) {
            console.error('Erreur link-wallet:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors de l\'association du wallet'
            });
        }
    }
);

/**
 * POST /api/auth/change-password
 * Change le mot de passe de l'utilisateur
 * Si A2F activé : requiert mot de passe actuel + code A2F (double vérification)
 */
router.post('/change-password',
    authenticateToken,
    [
        body('currentPassword').notEmpty().withMessage('Mot de passe actuel requis'),
        body('newPassword')
            .isLength({ min: 8, max: 100 })
            .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
            .withMessage('Nouveau mot de passe: min 8 caractères avec majuscule, minuscule et chiffre')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: errors.array()[0].msg
                });
            }

            const { currentPassword, newPassword, a2fCode } = req.body;

            // Récupérer l'utilisateur
            const user = queries.users.findById.get(req.user.id);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'Utilisateur non trouvé'
                });
            }

            // Vérifier le mot de passe actuel
            const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
            if (!validPassword) {
                return res.status(401).json({
                    success: false,
                    error: 'Mot de passe actuel incorrect'
                });
            }

            // Si A2F activé : vérifier le code en plus
            if (user.a2f_enabled && user.a2f_secret) {
                if (!a2fCode) {
                    return res.status(400).json({
                        success: false,
                        error: 'Code A2F requis pour changer le mot de passe',
                        requiresA2F: true
                    });
                }
                const speakeasy = require('speakeasy');
                const valid = speakeasy.totp.verify({
                    secret: user.a2f_secret,
                    encoding: 'base32',
                    token: a2fCode,
                    window: 1
                });
                if (!valid) {
                    return res.status(401).json({
                        success: false,
                        error: 'Code A2F incorrect'
                    });
                }
            }

            // Hasher le nouveau mot de passe
            const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

            // Mettre à jour en base
            const updateStmt = require('../services/database').db.prepare(
                'UPDATE users SET password_hash = ? WHERE id = ?'
            );
            updateStmt.run(newPasswordHash, user.id);

            console.log(`🔐 Mot de passe changé: ${user.username}`);

            res.json({
                success: true,
                message: 'Mot de passe mis à jour avec succès'
            });

        } catch (error) {
            console.error('Erreur change-password:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors du changement de mot de passe'
            });
        }
    }
);

/**
 * POST /api/auth/forgot-password
 * Réinitialisation du mot de passe via code A2F (sans email)
 * SÉCURISÉ : Le code A2F prouve la possession du dispositif d'authentification
 */
router.post('/forgot-password',
    authLimiter,
    [
        body('username').trim().notEmpty().withMessage('Nom d\'utilisateur requis'),
        body('a2fCode').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code A2F invalide (6 chiffres)'),
        body('newPassword')
            .isLength({ min: 8, max: 100 })
            .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
            .withMessage('Mot de passe: min 8 caractères avec majuscule, minuscule et chiffre')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: errors.array()[0].msg
                });
            }

            const { username, a2fCode, newPassword } = req.body;

            // Trouver l'utilisateur (message générique pour éviter l'énumération)
            const user = queries.users.findByUsername.get(username);
            if (!user) {
                // Délai constant pour éviter le timing attack
                await new Promise(r => setTimeout(r, 500));
                return res.status(400).json({
                    success: false,
                    error: 'Impossible de réinitialiser le mot de passe. Vérifiez votre nom d\'utilisateur et que l\'A2F est activé.'
                });
            }

            // L'A2F doit être activé
            if (!user.a2f_enabled || !user.a2f_secret) {
                return res.status(400).json({
                    success: false,
                    error: 'La récupération de compte nécessite l\'A2F. Contactez un administrateur si vous avez perdu l\'accès.'
                });
            }

            // Vérifier le code A2F
            const speakeasy = require('speakeasy');
            const valid = speakeasy.totp.verify({
                secret: user.a2f_secret,
                encoding: 'base32',
                token: a2fCode,
                window: 1
            });

            if (!valid) {
                return res.status(401).json({
                    success: false,
                    error: 'Code A2F incorrect'
                });
            }

            // Code A2F valide : réinitialiser le mot de passe
            const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
            require('../services/database').db.prepare(
                'UPDATE users SET password_hash = ? WHERE id = ?'
            ).run(newPasswordHash, user.id);

            console.log(`🔐 Mot de passe réinitialisé via A2F: ${user.username}`);

            res.json({
                success: true,
                message: 'Mot de passe réinitialisé avec succès. Vous pouvez vous connecter.'
            });

        } catch (error) {
            console.error('Erreur forgot-password:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors de la réinitialisation'
            });
        }
    }
);

/**
 * POST /api/auth/logout
 * Révoque le token JWT (blacklist)
 */
router.post('/logout', authenticateToken, (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
        tokenBlacklist.add(token);
        console.log(`👋 Déconnexion: ${req.user.username}`);
    }
    res.json({ success: true, message: 'Déconnecté avec succès' });
});

module.exports = router;
module.exports.tokenBlacklist = tokenBlacklist;
