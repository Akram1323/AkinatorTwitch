/**
 * Routes de gestion des jetons
 * Solde, historique, gift quotidien
 *
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');

const { queries } = require('../services/database');
const { authenticateToken } = require('../middleware/security');
const { claimDailyTokens, ALREADY_CLAIMED } = require('../services/dailyTokens');

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
 * POST /api/tokens/gift
 * Robinet quotidien de jetons gratuits — MÊME robinet que POST /api/auth/claim-daily
 * (les deux routes consomment la colonne `last_daily_claim`).
 *
 * Donne toujours 3 jetons : le champ `amount` du corps est encore accepté pour
 * ne pas casser les anciens appels, mais il est délibérément IGNORÉ (il permettait
 * auparavant de se servir jusqu'à 10 jetons/jour au lieu des 3 prévus).
 */
router.post('/gift', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }

        const claim = claimDailyTokens(user.id);

        if (!claim) {
            return res.status(ALREADY_CLAIMED.status).json(ALREADY_CLAIMED.body);
        }

        console.log(`🎁 Jetons quotidiens: ${req.user.username} +${claim.tokensAdded} jetons`);

        res.json({
            success: true,
            message: `${claim.tokensAdded} jetons quotidiens ajoutés !`,
            data: claim
        });

    } catch (error) {
        console.error('Erreur gift:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors du gift'
        });
    }
});

module.exports = router;
