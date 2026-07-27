/**
 * Routes d'administration
 * Gestion des utilisateurs et nettoyage des données (RGPD)
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');
const { runFullCleanup } = require('../services/cleanup');
const { authenticateToken, requireAdmin } = require('../middleware/security');
const { queries } = require('../services/database');
const { decryptIP, hashIPForLogging } = require('../services/encryption');
const { appendAudit, verifyAuditChain } = require('../services/auditService');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Toutes les routes admin nécessitent l'authentification ET les droits admin
router.use(authenticateToken);
router.use(requireAdmin);

/**
 * Liste blanche des colonnes de `users` exposables au panneau admin.
 * Volontairement une liste blanche (et non une liste noire) : toute nouvelle
 * colonne — potentiellement sensible — reste privée par défaut.
 * Exclus en particulier : password_hash, a2f_secret, a2f_last_step,
 * password_changed_at, wallet_address.
 */
const CHAMPS_UTILISATEUR_PUBLICS = [
    'id',
    'username',
    'tokens',
    'total_games',
    'last_daily_claim',
    'created_at',
    'last_login',
    'is_admin',
    'a2f_enabled',
    'locked_until',
    'failed_login_attempts',
    'avatar_url',
    'ip_address'
];

/**
 * Projette une ligne `users` sur la liste blanche.
 * Conserve le comportement historique : is_admin en booléen, IP déchiffrée.
 * @param {object} user Ligne brute issue de la base
 * @returns {object} Objet sûr à sérialiser en JSON
 */
function projectUser(user) {
    const safe = {};
    for (const champ of CHAMPS_UTILISATEUR_PUBLICS) {
        if (champ in user) {
            safe[champ] = user[champ];
        }
    }
    safe.is_admin = user.is_admin === 1;
    safe.ip_address = user.ip_address ? decryptIP(user.ip_address) : null;
    return safe;
}

/**
 * GET /api/admin/stats
 * Statistiques générales de la plateforme
 */
router.get('/stats', async (req, res) => {
    try {
        const db = require('../services/database').db;
        
        const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        const totalAdmins = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get().count;
        const totalGames = db.prepare('SELECT COUNT(*) as count FROM games').get().count;
        const totalTransactions = db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
        const totalTokens = db.prepare('SELECT SUM(tokens) as total FROM users').get().total || 0;
        
        res.json({
            success: true,
            data: {
                users: {
                    total: totalUsers,
                    admins: totalAdmins,
                    regular: totalUsers - totalAdmins
                },
                games: {
                    total: totalGames
                },
                transactions: {
                    total: totalTransactions
                },
                tokens: {
                    total: totalTokens
                }
            }
        });
    } catch (error) {
        console.error('❌ Erreur stats admin:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des statistiques'
        });
    }
});

/**
 * GET /api/admin/users
 * Liste tous les utilisateurs (avec pagination)
 */
router.get('/users', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        
        const users = queries.users.findAll.all(limit, offset);
        const total = queries.users.count.get().count;
        
        // Projection sur la liste blanche (IPs déchiffrées pour l'affichage admin)
        const safeUsers = users.map(projectUser);

        res.json({
            success: true,
            data: {
                users: safeUsers,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit)
                }
            }
        });
    } catch (error) {
        console.error('❌ Erreur liste utilisateurs:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des utilisateurs'
        });
    }
});

/**
 * GET /api/admin/users/:id
 * Détails d'un utilisateur spécifique
 */
router.get('/users/:id', async (req, res) => {
    try {
        const user = queries.users.findById.get(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }
        
        // Récupérer les transactions de l'utilisateur
        const transactions = queries.transactions.findByUser.all(user.id);
        
        // Récupérer les parties de l'utilisateur
        const games = queries.games.findByUser.all(user.id);
        
        res.json({
            success: true,
            data: {
                user: projectUser(user),
                transactions,
                games: games.length
            }
        });
    } catch (error) {
        console.error('❌ Erreur détails utilisateur:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des détails'
        });
    }
});

/**
 * DELETE /api/admin/users/:id
 * Supprime un utilisateur (et toutes ses données associées via CASCADE)
 */
router.delete('/users/:id', async (req, res) => {
    try {
        const user = queries.users.findById.get(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }
        
        // Ne pas permettre de supprimer un autre admin
        if (user.is_admin === 1 && user.id !== req.user.id) {
            return res.status(403).json({
                success: false,
                error: 'Impossible de supprimer un autre administrateur'
            });
        }
        
        queries.users.delete.run(req.params.id);

        appendAudit('admin.user.delete', { userId: req.user.id, details: { targetId: req.params.id } });

        res.json({
            success: true,
            message: `Utilisateur ${user.username} supprimé avec succès`
        });
    } catch (error) {
        console.error('❌ Erreur suppression utilisateur:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la suppression'
        });
    }
});

/**
 * POST /api/admin/users/:id/tokens
 * Attribue des jetons à un utilisateur.
 * Body : { action: 'add'|'set', amount: entier, reason: string obligatoire }
 * 'add' incrémente le solde (voie normale), 'set' fixe une valeur absolue
 * (correction exceptionnelle). Trace une transaction 'admin_grant' (delta).
 */
router.post('/users/:id/tokens', async (req, res) => {
    try {
        const user = queries.users.findById.get(req.params.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }

        const { action, amount, reason } = req.body;

        if (!['add', 'set'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: "Action invalide (attendu : 'add' ou 'set')"
            });
        }

        if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || Math.abs(amount) > 1000000) {
            return res.status(400).json({
                success: false,
                error: 'Montant invalide (entier, maximum 1 000 000 en valeur absolue)'
            });
        }

        if (typeof reason !== 'string' || reason.trim().length === 0 || reason.trim().length > 200) {
            return res.status(400).json({
                success: false,
                error: 'Raison obligatoire (200 caractères max)'
            });
        }

        const oldBalance = user.tokens;
        const newBalance = action === 'add' ? oldBalance + amount : amount;

        if (newBalance < 0) {
            return res.status(400).json({
                success: false,
                error: `Solde final négatif refusé (solde actuel : ${oldBalance})`
            });
        }

        const db = require('../services/database').db;
        db.transaction(() => {
            if (action === 'add') {
                queries.users.updateTokens.run(amount, req.params.id);
            } else {
                queries.users.setTokens.run(amount, req.params.id);
            }
            queries.transactions.create.run(
                uuidv4(), req.params.id, 'admin_grant', newBalance - oldBalance, null, 'completed'
            );
        })();

        console.log(`🔧 Admin ${req.user.username} attribue des jetons à ${user.username}: ${oldBalance} -> ${newBalance} (${action}, ${reason.trim()})`);

        const rawIP = req.ip || req.connection.remoteAddress || 'unknown';
        appendAudit('admin.user.tokens', {
            userId: req.user.id,
            ipHash: hashIPForLogging(rawIP),
            details: {
                targetId: req.params.id,
                targetUsername: user.username,
                adminUsername: req.user.username,
                action,
                amount,
                oldBalance,
                newBalance,
                reason: reason.trim()
            }
        });

        res.json({
            success: true,
            message: `Jetons de ${user.username} : ${oldBalance} → ${newBalance}`,
            data: {
                userId: req.params.id,
                oldBalance,
                newBalance
            }
        });
    } catch (error) {
        console.error('❌ Erreur attribution jetons:', error);
        res.status(500).json({
            success: false,
            error: "Erreur lors de l'attribution"
        });
    }
});

/**
 * POST /api/admin/users/:id/promote
 * Promouvoir un utilisateur en administrateur
 */
router.post('/users/:id/promote', async (req, res) => {
    try {
        const user = queries.users.findById.get(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }
        
        if (user.is_admin === 1) {
            return res.status(400).json({
                success: false,
                error: 'Utilisateur déjà administrateur'
            });
        }
        
        const db = require('../services/database').db;
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(req.params.id);

        appendAudit('admin.user.promote', { userId: req.user.id, details: { targetId: req.params.id } });

        res.json({
            success: true,
            message: `${user.username} promu administrateur`
        });
    } catch (error) {
        console.error('❌ Erreur promotion admin:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la promotion'
        });
    }
});

/**
 * POST /api/admin/users/:id/demote
 * Rétrograder un administrateur en utilisateur normal
 */
router.post('/users/:id/demote', async (req, res) => {
    try {
        const user = queries.users.findById.get(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }
        
        // Ne pas permettre de se rétrograder soi-même
        if (user.id === req.user.id) {
            return res.status(403).json({
                success: false,
                error: 'Impossible de vous rétrograder vous-même'
            });
        }
        
        if (user.is_admin !== 1) {
            return res.status(400).json({
                success: false,
                error: 'Utilisateur n\'est pas administrateur'
            });
        }
        
        const db = require('../services/database').db;
        db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(req.params.id);

        appendAudit('admin.user.demote', { userId: req.user.id, details: { targetId: req.params.id } });

        res.json({
            success: true,
            message: `${user.username} rétrogradé en utilisateur normal`
        });
    } catch (error) {
        console.error('❌ Erreur rétrogradation:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la rétrogradation'
        });
    }
});

/**
 * POST /api/admin/users/:id/unlock
 * Déverrouiller un compte utilisateur (réinitialiser les tentatives de connexion)
 * Sécurisé : Nécessite authentification admin
 */
router.post('/users/:id/unlock', async (req, res) => {
    try {
        const user = queries.users.findById.get(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }
        
        // Réinitialiser les tentatives et déverrouiller
        queries.users.resetFailedLogin.run(req.params.id);

        appendAudit('admin.user.unlock', { userId: req.user.id, details: { targetId: req.params.id } });

        res.json({
            success: true,
            message: `Compte ${user.username} déverrouillé avec succès`
        });
    } catch (error) {
        console.error('❌ Erreur déverrouillage:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors du déverrouillage'
        });
    }
});

/**
 * GET /api/admin/token-requests
 * Demandes de jetons, filtrées par statut (défaut : les demandes en attente).
 */
router.get('/token-requests', async (req, res) => {
    try {
        const statut = ['pending', 'approved', 'rejected'].includes(req.query.status)
            ? req.query.status
            : 'pending';
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 200);

        const demandes = queries.tokenRequests.findByStatus.all(statut, limit);

        res.json({
            success: true,
            data: demandes.map(d => ({
                id: d.id,
                userId: d.user_id,
                username: d.username,
                userTokens: d.user_tokens,
                amount: d.amount,
                reason: d.reason,
                status: d.status,
                createdAt: d.created_at,
                resolvedAt: d.resolved_at
            }))
        });
    } catch (error) {
        console.error('❌ Erreur liste demandes de jetons:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des demandes'
        });
    }
});

/**
 * Résout une demande de jetons.
 *
 * L'UPDATE est conditionné à `status = 'pending'` : si la demande a déjà été
 * traitée (double clic, deux admins simultanés), `changes` vaut 0 et rien n'est
 * crédité. Le crédit et le changement de statut sont dans la MÊME transaction,
 * donc jamais l'un sans l'autre.
 *
 * @param {'approved'|'rejected'} decision
 */
function resoudreDemande(decision) {
    return async (req, res) => {
        try {
            const demande = queries.tokenRequests.findById.get(req.params.id);

            if (!demande) {
                return res.status(404).json({ success: false, error: 'Demande introuvable' });
            }

            if (demande.status !== 'pending') {
                return res.status(409).json({
                    success: false,
                    error: `Demande déjà traitée (${demande.status})`
                });
            }

            const demandeur = queries.users.findById.get(demande.user_id);
            if (!demandeur) {
                return res.status(404).json({ success: false, error: 'Demandeur introuvable' });
            }

            const db = require('../services/database').db;
            const applique = db.transaction(() => {
                const maj = queries.tokenRequests.resolve.run(decision, req.user.id, demande.id);
                if (maj.changes === 0) return false;

                if (decision === 'approved') {
                    queries.users.updateTokens.run(demande.amount, demande.user_id);
                    queries.transactions.create.run(
                        uuidv4(), demande.user_id, 'admin_grant', demande.amount, null, 'completed'
                    );
                }
                return true;
            })();

            // Course perdue : un autre admin a résolu la demande entre-temps.
            if (!applique) {
                return res.status(409).json({ success: false, error: 'Demande déjà traitée' });
            }

            const nouveauSolde = decision === 'approved'
                ? demandeur.tokens + demande.amount
                : demandeur.tokens;

            const rawIP = req.ip || req.connection.remoteAddress || 'unknown';
            appendAudit(`admin.token_request.${decision === 'approved' ? 'approve' : 'reject'}`, {
                userId: req.user.id,
                ipHash: hashIPForLogging(rawIP),
                details: {
                    requestId: demande.id,
                    targetId: demande.user_id,
                    targetUsername: demandeur.username,
                    adminUsername: req.user.username,
                    amount: demande.amount,
                    reason: demande.reason,
                    oldBalance: demandeur.tokens,
                    newBalance: nouveauSolde
                }
            });

            console.log(`📨 Admin ${req.user.username} ${decision === 'approved' ? 'approuve' : 'refuse'} la demande de ${demandeur.username} (${demande.amount} jetons)`);

            res.json({
                success: true,
                message: decision === 'approved'
                    ? `Demande approuvée : ${demandeur.username} +${demande.amount} jetons`
                    : `Demande de ${demandeur.username} refusée`,
                data: {
                    requestId: demande.id,
                    status: decision,
                    userId: demande.user_id,
                    oldBalance: demandeur.tokens,
                    newBalance: nouveauSolde
                }
            });
        } catch (error) {
            console.error('❌ Erreur résolution demande de jetons:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors du traitement de la demande'
            });
        }
    };
}

/** POST /api/admin/token-requests/:id/approve — crédite le demandeur. */
router.post('/token-requests/:id/approve', resoudreDemande('approved'));

/** POST /api/admin/token-requests/:id/reject — clôt la demande sans créditer. */
router.post('/token-requests/:id/reject', resoudreDemande('rejected'));

/**
 * GET /api/admin/cleanup-ips
 * Nettoie les IPs anciennes (plus de 12 mois)
 * Conformité RGPD - Recommandation CNIL
 */
router.get('/cleanup-ips', async (req, res) => {
    try {
        const result = runFullCleanup();
        
        res.json({
            success: true,
            message: `Nettoyage terminé: ${result.totalDeleted} IP(s) supprimée(s)`,
            data: result
        });
    } catch (error) {
        console.error('❌ Erreur nettoyage IPs:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors du nettoyage des IPs'
        });
    }
});

/**
 * GET /api/admin/audit
 * Dernières entrées du journal d'audit
 */
router.get('/audit', async (req, res) => {
    try {
        const db = require('../services/database').db;
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
        // `event_type` accepte plusieurs types séparés par des virgules : un même
        // tableau du panneau admin réunit des événements de types distincts
        // (attribution directe + demande de jetons approuvée).
        const eventTypes = typeof req.query.event_type === 'string' && req.query.event_type.length <= 500
            ? req.query.event_type.split(',').map(t => t.trim()).filter(Boolean)
            : [];

        const entries = eventTypes.length > 0
            ? db.prepare(
                `SELECT * FROM audit_log WHERE event_type IN (${eventTypes.map(() => '?').join(',')})
                 ORDER BY id DESC LIMIT ?`
            ).all(...eventTypes, limit)
            : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);

        res.json({ success: true, data: { entries } });
    } catch (error) {
        console.error('❌ Erreur audit log:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la récupération du journal' });
    }
});

/**
 * GET /api/admin/audit/verify
 * Vérifie l'intégrité de la chaîne d'audit
 */
router.get('/audit/verify', async (req, res) => {
    try {
        res.json({ success: true, data: verifyAuditChain() });
    } catch (error) {
        console.error('❌ Erreur vérification audit:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la vérification de la chaîne' });
    }
});

module.exports = router;
