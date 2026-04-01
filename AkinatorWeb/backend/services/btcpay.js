/**
 * Service BTCPay Server
 * Intégration paiement crypto open-source, sans intermédiaire
 *
 * SÉCURITÉ CYBERSÉCURITÉ:
 * - Vérification des webhooks par HMAC-SHA256 (signature cryptographique)
 * - Comparaison timing-safe (protection contre timing attacks)
 * - Invoices uniques par paiement (protection replay attack)
 * - Aucune clé privée stockée côté serveur
 *
 * @author AkinatorTwitch Team
 * @version 1.0
 */

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config/config');

const isConfigured = !!(
    config.btcpay.serverUrl &&
    config.btcpay.apiKey &&
    config.btcpay.storeId
);

if (isConfigured) {
    console.log('✅ BTCPay Server configuré:', config.btcpay.serverUrl);
} else {
    console.log('ℹ️  BTCPay Server: mode démo (BTCPAY_SERVER_URL non défini)');
}

/**
 * Crée une facture de paiement BTCPay
 * En mode démo : retourne une facture simulée
 * En mode production : appelle l'API BTCPay réelle
 *
 * @param {Object} params
 * @param {number} params.amount - Montant en EUR
 * @param {string} params.currency - Devise (EUR par défaut)
 * @param {string} params.orderId - ID de la transaction interne
 * @param {Object} params.metadata - Métadonnées (userId, pack, etc.)
 * @returns {Promise<{id, checkoutLink, isDemo}>}
 */
async function createInvoice({ amount, currency = 'EUR', orderId, metadata = {} }) {
    if (!isConfigured) {
        // Mode démo : génère une fausse invoice pour la démonstration
        const demoId = 'DEMO_' + crypto.randomBytes(8).toString('hex').toUpperCase();
        console.log(`⚡ BTCPay démo: Invoice ${demoId} créée (simulation)`);
        return {
            id: demoId,
            checkoutLink: null,
            isDemo: true,
            amount,
            currency
        };
    }

    try {
        const response = await axios.post(
            `${config.btcpay.serverUrl}/api/v1/stores/${config.btcpay.storeId}/invoices`,
            {
                amount: amount.toString(),
                currency,
                orderId,
                metadata,
                checkout: {
                    speedPolicy: 'MediumSpeed',
                    expirationMinutes: 30,
                    redirectURL: config.btcpay.appUrl
                }
            },
            {
                headers: {
                    'Authorization': `token ${config.btcpay.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        console.log(`⚡ BTCPay: Invoice ${response.data.id} créée`);

        return {
            id: response.data.id,
            checkoutLink: response.data.checkoutLink,
            isDemo: false,
            amount,
            currency
        };
    } catch (error) {
        const msg = error.response?.data || error.message;
        console.error('❌ BTCPay createInvoice error:', msg);
        throw new Error('Impossible de créer la facture BTCPay: ' + (error.response?.status || error.message));
    }
}

/**
 * Récupère le statut d'une invoice BTCPay
 *
 * Statuts possibles:
 *   New        → En attente de paiement
 *   Processing → Paiement reçu, en attente de confirmations
 *   Settled    → Paiement confirmé ✅
 *   Expired    → Délai dépassé (30 min)
 *   Invalid    → Montant incorrect ou annulé
 *
 * @param {string} invoiceId
 * @returns {Promise<{id, status, isDemo}>}
 */
async function getInvoiceStatus(invoiceId) {
    // Mode démo : les invoices DEMO_* restent en attente (admin doit approuver manuellement)
    if (invoiceId.startsWith('DEMO_')) {
        return {
            id: invoiceId,
            status: 'New',
            isDemo: true
        };
    }

    if (!isConfigured) {
        throw new Error('BTCPay Server non configuré');
    }

    try {
        const response = await axios.get(
            `${config.btcpay.serverUrl}/api/v1/stores/${config.btcpay.storeId}/invoices/${invoiceId}`,
            {
                headers: {
                    'Authorization': `token ${config.btcpay.apiKey}`
                },
                timeout: 10000
            }
        );

        return {
            id: response.data.id,
            status: response.data.status, // New | Processing | Expired | Invalid | Settled
            isDemo: false
        };
    } catch (error) {
        console.error('❌ BTCPay getInvoiceStatus error:', error.message);
        throw new Error('Impossible de vérifier le statut de la facture');
    }
}

/**
 * Vérifie la signature HMAC-SHA256 d'un webhook BTCPay
 *
 * PRINCIPE CYBERSÉCURITÉ:
 * BTCPay Server signe chaque webhook avec un secret partagé via HMAC-SHA256.
 * Seul BTCPay (qui connaît le secret) peut produire une signature valide.
 * → Garantit l'authenticité et l'intégrité du webhook (non falsifiable).
 *
 * On utilise crypto.timingSafeEqual() pour éviter les timing attacks :
 * une comparaison normale (===) fuit des informations sur la longueur
 * du préfixe commun via le temps de réponse.
 *
 * @param {Buffer} rawBody - Corps brut de la requête (avant parsing JSON)
 * @param {string} signatureHeader - Header BTCPay-Sig (format: "sha256=<hex>")
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
    if (!config.btcpay.webhookSecret) {
        console.warn('⚠️ BTCPAY_WEBHOOK_SECRET non configuré - webhook non vérifié');
        return false;
    }

    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
        console.warn('⚠️ Header BTCPay-Sig manquant ou mal formaté');
        return false;
    }

    const receivedHex = signatureHeader.replace('sha256=', '');

    // Calculer la signature attendue avec le secret partagé
    const expectedHex = crypto
        .createHmac('sha256', config.btcpay.webhookSecret)
        .update(rawBody)
        .digest('hex');

    // Comparaison timing-safe : même temps de réponse qu'il y ait 0 ou 64 caractères communs
    try {
        const receivedBuf = Buffer.from(receivedHex, 'hex');
        const expectedBuf = Buffer.from(expectedHex, 'hex');

        if (receivedBuf.length !== expectedBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(receivedBuf, expectedBuf);
    } catch {
        return false;
    }
}

module.exports = {
    isConfigured,
    createInvoice,
    getInvoiceStatus,
    verifyWebhookSignature
};
