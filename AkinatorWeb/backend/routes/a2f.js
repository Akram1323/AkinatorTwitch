/**
 * Routes A2F (Authentification à 2 Facteurs)
 * Implémentation TOTP (Time-based One-Time Password)
 */

const express = require('express');
const router = express.Router();
const { authenticateToken, a2fLimiter } = require('../middleware/security');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { db, queries } = require('../services/database');
const { appendAudit } = require('../services/auditService');
const { generateBackupCodes, verifyTotp, consumeBackupCode } = require('../services/twoFactor');

/**
 * POST /api/a2f/setup
 * Génère un secret A2F et le QR code
 */
router.post('/setup', authenticateToken, async (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        // Vérifier si A2F déjà activé
        if (user.a2f_enabled) {
            return res.status(400).json({ 
                success: false, 
                error: 'A2F déjà activé. Désactivez-le d\'abord.' 
            });
        }

        // Générer un nouveau secret avec speakeasy
        const secretObj = speakeasy.generateSecret({
            name: `AkinatorTwitch:${user.username}`,
            issuer: 'AkinatorTwitch',
            length: 20
        });
        
        const secret = secretObj.base32;
        
        // Stocker temporairement le secret (non activé)
        // Le compteur anti-rejeu appartient au secret : en remplacer un sans le
        // remettre à zéro ferait refuser « code déjà utilisé » un code pourtant
        // neuf, tant que la fenêtre de 30 s du dernier code validé n'est pas passée.
        const updateStmt = db.prepare(
            'UPDATE users SET a2f_secret = ?, a2f_enabled = 0, a2f_last_step = NULL WHERE id = ?'
        );
        updateStmt.run(secret, user.id);

        // Générer le QR code en base64
        const qrCodeDataUrl = await QRCode.toDataURL(secretObj.otpauth_url, {
            width: 200,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });

        console.log(`🔐 A2F setup initié: ${user.username}`);

        res.json({
            success: true,
            data: {
                qrCode: qrCodeDataUrl,
                // Le QR code encode déjà ce secret en clair : le renvoyer en texte
                // n'ajoute aucune exposition et permet l'appairage manuel (poste
                // sans caméra, lecteur d'écran, application sans scanner).
                secret,
                otpauthUrl: secretObj.otpauth_url
            }
        });

    } catch (error) {
        console.error('Erreur A2F setup:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la configuration A2F' });
    }
});

/**
 * POST /api/a2f/verify-setup
 * Vérifie le code A2F et active l'A2F
 */
router.post('/verify-setup', a2fLimiter, authenticateToken, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code || code.length !== 6) {
            return res.status(400).json({ success: false, error: 'Code invalide (6 chiffres)' });
        }

        const user = queries.users.findById.get(req.user.id);
        if (!user || !user.a2f_secret) {
            return res.status(400).json({ success: false, error: 'Aucun secret A2F configuré' });
        }

        // Vérifier le code (garde anti-rejeu incluse). Le secret utilisé ici est
        // celui déjà persisté en DB par /setup (a2f_secret lu à l'instant sur `user`),
        // donc user.a2f_secret est bien la valeur en cours de configuration.
        const totpResult = verifyTotp(user, code);
        if (!totpResult.ok) {
            return res.status(401).json({ success: false, error: totpResult.error });
        }

        // Activation et génération des codes de secours dans la MÊME transaction.
        // Les découpler laisserait une fenêtre où la 2FA est active sans qu'aucun
        // code n'existe : si le second appel échouait (réseau, onglet fermé),
        // l'utilisateur serait protégé sans filet et l'ignorerait.
        const activer = db.transaction(() => {
            db.prepare('UPDATE users SET a2f_enabled = 1 WHERE id = ?').run(user.id);
            return generateBackupCodes(user.id);
        });
        const codes = activer();

        console.log(`✅ A2F activé: ${user.username}`);

        appendAudit('a2f.enabled', { userId: user.id });

        res.json({
            success: true,
            message: 'A2F activé avec succès',
            data: { codes }
        });

    } catch (error) {
        console.error('Erreur verify-setup:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de l\'activation A2F' });
    }
});

/**
 * POST /api/a2f/verify
 * Vérifie un code A2F (pour la connexion)
 * SÉCURISÉ : Utilise req.user.id du token JWT pour éviter IDOR
 */
router.post('/verify', a2fLimiter, authenticateToken, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code || code.length !== 6) {
            return res.status(400).json({ success: false, error: 'Code invalide (6 chiffres)' });
        }

        // Utiliser req.user.id du token JWT (sécurisé contre IDOR)
        const user = queries.users.findById.get(req.user.id);
        if (!user || !user.a2f_enabled || !user.a2f_secret) {
            return res.status(400).json({ success: false, error: 'A2F non configuré' });
        }

        const totpResult = verifyTotp(user, code);
        if (!totpResult.ok) {
            return res.status(401).json({ success: false, error: totpResult.error });
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Erreur A2F verify:', error);
        res.status(500).json({ success: false, error: 'Erreur de vérification' });
    }
});

/**
 * POST /api/a2f/disable
 * Désactive l'A2F
 */
router.post('/disable', authenticateToken, async (req, res) => {
    try {
        const { code, password } = req.body;
        const bcrypt = require('bcrypt');

        // Garde explicite : bcrypt.compare(undefined, hash) lève, ce qui
        // produirait un 500 là où la requête est simplement incomplète.
        if (typeof password !== 'string' || password.length === 0) {
            return res.status(400).json({ success: false, error: 'Mot de passe requis' });
        }

        const user = queries.users.findById.get(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        // Facteur 1 : le mot de passe, toujours exigé
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
        }

        // Facteur 2 : TOTP ou code de secours. Accepter le code de secours ferme
        // l'impasse de la perte du téléphone — le login les accepte déjà, sans quoi
        // l'utilisateur reste bloqué avec une 2FA qu'il ne peut plus désactiver.
        let methode = 'totp';
        if (user.a2f_enabled && user.a2f_secret) {
            const saisie = String(code || '').trim();

            if (saisie.length === 10) {
                methode = 'backup_code';
                if (!consumeBackupCode(user.id, saisie)) {
                    return res.status(401).json({ success: false, error: 'Code de secours invalide' });
                }
            } else {
                const totpResult = verifyTotp(user, saisie);
                if (!totpResult.ok) {
                    return res.status(401).json({ success: false, error: totpResult.error });
                }
            }
        }

        // Désactivation et purge des codes dans la même transaction : un code
        // survivant n'aurait plus aucun usage et resterait un secret à protéger.
        const desactiver = db.transaction(() => {
            db.prepare('UPDATE users SET a2f_enabled = 0, a2f_secret = NULL WHERE id = ?').run(user.id);
            db.prepare('DELETE FROM a2f_backup_codes WHERE user_id = ?').run(user.id);
        });
        desactiver();

        console.log(`🔓 A2F désactivé: ${user.username}`);

        appendAudit('a2f.disabled', { userId: user.id, details: { method: methode } });

        res.json({
            success: true,
            message: 'A2F désactivé'
        });

    } catch (error) {
        console.error('Erreur A2F disable:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la désactivation' });
    }
});

/**
 * POST /api/a2f/backup-codes
 * Regénère les codes de secours (affichés une seule fois).
 */
router.post('/backup-codes', authenticateToken, async (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        if (!user || !user.a2f_enabled) {
            return res.status(400).json({ success: false, error: 'La 2FA doit être activée' });
        }
        const codes = generateBackupCodes(user.id);
        appendAudit('a2f.backup_codes.generated', { userId: user.id });
        res.json({
            success: true,
            data: { codes },
            message: 'Conservez ces codes en lieu sûr : ils ne seront plus jamais affichés.'
        });
    } catch (error) {
        console.error('Erreur A2F backup-codes:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la génération des codes' });
    }
});

/**
 * GET /api/a2f/status
 * Vérifie le statut A2F de l'utilisateur
 */
router.get('/status', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        res.json({
            success: true,
            data: {
                enabled: user.a2f_enabled === 1
            }
        });

    } catch (error) {
        console.error('Erreur A2F status:', error);
        res.status(500).json({ success: false, error: 'Erreur' });
    }
});

module.exports = router;
