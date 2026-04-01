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
 * Modifier les jetons d'un utilisateur
 */
router.post('/users/:id/tokens', async (req, res) => {
    try {
        // Vérifier d'abord que l'utilisateur existe
        const user = queries.users.findById.get(req.params.id);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }
        
        const { amount } = req.body;
        
        // Validation stricte du montant
        if (typeof amount !== 'number' || isNaN(amount) || !Number.isInteger(amount) || amount < 0) {
            return res.status(400).json({
                success: false,
                error: 'Montant invalide (doit être un entier positif)'
            });
        }
        
        // Logger l'action pour audit
        console.log(`🔧 Admin ${req.user.username} modifie les jetons de ${user.username}: ${user.tokens} -> ${amount}`);
        
        queries.users.setTokens.run(amount, req.params.id);
        
        res.json({
            success: true,
            message: `Jetons de ${user.username} mis à jour: ${amount}`,
            data: {
                userId: req.params.id,
                tokens: amount
            }
        });
    } catch (error) {
        console.error('❌ Erreur modification jetons:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la modification'
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
 * GET /api/admin/transactions/pending
 * Liste les transactions en attente (achats BTCPay)
 */
router.get('/transactions/pending', async (req, res) => {
    try {
        const db = require('../services/database').db;
        const pending = db.prepare(`
            SELECT t.*, u.username
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE t.status = 'pending' AND t.type = 'purchase'
            ORDER BY t.created_at DESC
            LIMIT 50
        `).all();

        res.json({ success: true, data: pending });
    } catch (error) {
        console.error('❌ Erreur transactions pending:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la récupération' });
    }
});

/**
 * POST /api/admin/transactions/:id/approve
 * Approuver manuellement une transaction (crédite les jetons)
 */
router.post('/transactions/:id/approve', async (req, res) => {
    try {
        const tx = queries.transactions.findById.get(req.params.id);
        if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });
        if (tx.status !== 'pending') return res.status(400).json({ success: false, error: 'Transaction déjà traitée' });

        const db = require('../services/database').db;
        db.transaction(() => {
            queries.transactions.updateStatus.run('completed', tx.id);
            queries.users.updateTokens.run(tx.amount, tx.user_id);
        })();

        console.log(`✅ Admin ${req.user.username} approuve transaction ${tx.id} (+${tx.amount} jetons)`);

        res.json({ success: true, message: `Transaction approuvée: +${tx.amount} jetons crédités` });
    } catch (error) {
        console.error('❌ Erreur approbation:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de l\'approbation' });
    }
});

/**
 * POST /api/admin/transactions/:id/reject
 * Rejeter une transaction
 */
router.post('/transactions/:id/reject', async (req, res) => {
    try {
        const tx = queries.transactions.findById.get(req.params.id);
        if (!tx) return res.status(404).json({ success: false, error: 'Transaction introuvable' });
        if (tx.status !== 'pending') return res.status(400).json({ success: false, error: 'Transaction déjà traitée' });

        queries.transactions.updateStatus.run('failed', tx.id);

        console.log(`❌ Admin ${req.user.username} rejette transaction ${tx.id}`);

        res.json({ success: true, message: 'Transaction rejetée' });
    } catch (error) {
        console.error('❌ Erreur rejet:', error);
        res.status(500).json({ success: false, error: 'Erreur lors du rejet' });
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

module.exports = router;
