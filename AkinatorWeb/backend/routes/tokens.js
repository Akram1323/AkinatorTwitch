/**
 * Routes de gestion des jetons
 * Solde, historique, gift quotidien
 *
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');
const { body, validationResult } = require('express-validator');

const { queries } = require('../services/database');
const { authenticateToken } = require('../middleware/security');

const router = express.Router();

/**
 * GET /api/tokens/balance
 * Récupère le solde de jetons de l'utilisateur
 */
router.get('/balance', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }

        res.json({
            success: true,
            data: {
                tokens: user.tokens,
                totalGames: user.total_games
            }
        });

    } catch (error) {
        console.error('Erreur balance:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération du solde'
        });
    }
});

/**
 * GET /api/tokens/transactions
 * Récupère l'historique des transactions
 */
router.get('/transactions', authenticateToken, (req, res) => {
    try {
        const userTransactions = queries.transactions.findByUser.all(req.user.id);

        res.json({
            success: true,
            data: userTransactions.map(tx => ({
                id: tx.id,
                type: tx.type,
                amount: tx.amount,
                status: tx.status,
                txHash: tx.tx_hash,
                createdAt: tx.created_at
            }))
        });

    } catch (error) {
        console.error('Erreur transactions:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des transactions'
        });
    }
});

/**
 * POST /api/tokens/gift (Demo)
 * Ajoute des jetons gratuits (limité à 1 fois par jour)
 */
router.post('/gift',
    authenticateToken,
    [
        body('amount')
            .optional()
            .isInt({ min: 1, max: 10 })
            .withMessage('Amount must be between 1 and 10')
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

            const user = queries.users.findById.get(req.user.id);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'Utilisateur non trouvé'
                });
            }

            // Validation et parsing sécurisé du montant
            const amount = req.body.amount ? parseInt(req.body.amount) : 5;
            if (isNaN(amount) || amount < 1 || amount > 10) {
                return res.status(400).json({
                    success: false,
                    error: 'Montant invalide (doit être entre 1 et 10)'
                });
            }

            const tokensToAdd = Math.min(amount, 10); // Max 10 en gift

            // Opération atomique : vérifie ET met à jour en une seule requête (protection race condition)
            const result = queries.users.claimGiftAtomic.run(tokensToAdd, req.user.id);

            // Si aucune ligne n'a été modifiée, c'est que le gift a déjà été utilisé aujourd'hui
            if (result.changes === 0) {
                return res.status(429).json({
                    success: false,
                    error: 'Vous avez déjà utilisé le gift aujourd\'hui. Réessayez demain.'
                });
            }

            const updatedUser = queries.users.findById.get(req.user.id);

            console.log(`🎁 Gift: ${req.user.username} +${tokensToAdd} jetons`);

            res.json({
                success: true,
                message: `${tokensToAdd} jetons offerts !`,
                data: {
                    tokensAdded: tokensToAdd,
                    newBalance: updatedUser.tokens
                }
            });

        } catch (error) {
            console.error('Erreur gift:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors du gift'
            });
        }
    }
);

module.exports = router;
