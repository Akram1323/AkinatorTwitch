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
const { decryptIP } = require('../services/encryption');
const { appendAudit, verifyAuditChain } = require('../services/auditService');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Toutes les routes admin nécessitent l'authentification ET les droits admin
router.use(authenticateToken);
router.use(requireAdmin);

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
        
        // Déchiffrer les IPs pour l'affichage admin
        const usersWithDecryptedIPs = users.map(user => ({
            ...user,
            ip_address: user.ip_address ? decryptIP(user.ip_address) : null,
            is_admin: user.is_admin === 1
        }));
        
        res.json({
            success: true,
            data: {
                users: usersWithDecryptedIPs,
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
                user: {
                    ...user,
                    ip_address: user.ip_address ? decryptIP(user.ip_address) : null,
                    is_admin: user.is_admin === 1
                },
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

        if (typeof amount !== 'number' || !Number.isInteger(amount)) {
            return res.status(400).json({
                success: false,
                error: 'Montant invalide (doit être un entier)'
            });
        }

        if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 200) {
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

        appendAudit('admin.user.tokens', {
            userId: req.user.id,
            details: { targetId: req.params.id, action, amount, reason: reason.trim() }
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
        const entries = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);

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
