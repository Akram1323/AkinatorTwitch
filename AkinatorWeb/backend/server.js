/**
 * Serveur principal Akinator Twitch Web
 * API REST sécurisée avec Express
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

// Configuration
const config = require('./config/config');

// Middleware de sécurité
const {
    helmetConfig,
    globalLimiter,
    sanitizeInput,
    securityLogger,
    extraHeaders
} = require('./middleware/security');

// Base de données
const { initializeTables } = require('./services/database');

// Services de nettoyage
const { runFullCleanup } = require('./services/cleanup');

// Routes
const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/game');
const tokenRoutes = require('./routes/tokens');
const a2fRoutes = require('./routes/a2f');
const avatarRoutes = require('./routes/avatar');
const adminRoutes = require('./routes/admin');

// Initialisation Express
const app = express();

// Configuration pour obtenir la vraie IP (si derrière un proxy)
// '1' = faire confiance au premier proxy uniquement (plus sécurisé que true)
app.set('trust proxy', 1);

// ===========================================
// MIDDLEWARE GLOBAUX
// ===========================================

// Sécurité (Helmet)
app.use(helmetConfig);

// En-têtes additionnels (Permissions-Policy, Reporting-Endpoints)
app.use(extraHeaders);

// CORS
app.use(cors(config.cors));

// Parser JSON
app.use(express.json({ limit: '1mb' }));

// Cookies httpOnly (access/refresh tokens)
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Rate limiting global
app.use(globalLimiter);

// Sanitization des entrées
app.use(sanitizeInput);

// Logger de sécurité
app.use(securityLogger);

// ===========================================
// FICHIERS STATIQUES (Frontend)
// ===========================================

app.use(express.static(path.join(__dirname, '../frontend')));

// ===========================================
// ROUTES API
// ===========================================

// Route CSRF (doit être avant les autres routes)
const { getCSRFToken, csrfProtection } = require('./middleware/csrf');
const { authenticateToken } = require('./middleware/security');
app.get('/api/csrf-token', authenticateToken, getCSRFToken);

// Rapport de violations CSP : reçu directement du navigateur, sans token CSRF
// (doit être avant les routers protégés par csrfProtection)
app.post('/api/csp-report',
    express.json({ type: ['application/json', 'application/csp-report', 'application/reports+json'] }),
    (req, res) => {
        const { appendAudit } = require('./services/auditService');
        appendAudit('csp.violation', { details: req.body || {} });
        console.warn('⚠️ SECURITY: violation CSP signalée', JSON.stringify(req.body).slice(0, 300));
        res.status(204).end();
    });

// Sécurité RFC 9116 : politique de divulgation des vulnérabilités
app.get('/.well-known/security.txt', (req, res) => {
    res.type('text/plain').send([
        'Contact: mailto:sirejambon@gmail.com',
        'Expires: 2027-07-06T00:00:00.000Z',
        'Preferred-Languages: fr, en',
        'Canonical: https://akinator-twitch.onrender.com/.well-known/security.txt'
    ].join('\n') + '\n');
});

// Routes API
// Note: CSRF désactivé temporairement pour les routes auth (login/register)
// car elles nécessitent un token CSRF qui n'est disponible qu'après authentification
app.use('/api/auth', authRoutes);
app.use('/api/game', gameRoutes);

// IMPORTANT : `authenticateToken` DOIT précéder `csrfProtection`.
// csrfProtection a besoin de `req.user` pour valider le token CSRF ; les routers
// n'appellent authenticateToken qu'en interne (donc trop tard). Avec l'ordre
// inverse, `req.user` était toujours undefined et aucune vérification CSRF
// n'était appliquée. Les appels internes à authenticateToken sont conservés
// (idempotents) pour que les routers restent sûrs s'ils sont montés ailleurs.
app.use('/api/tokens', authenticateToken, csrfProtection, tokenRoutes);
app.use('/api/a2f', authenticateToken, csrfProtection, a2fRoutes);
app.use('/api/avatar', authenticateToken, csrfProtection, avatarRoutes);
app.use('/api/admin', authenticateToken, csrfProtection, adminRoutes);

// Route de santé
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Akinator Twitch API is running',
        version: '2.0.0',
        timestamp: new Date().toISOString()
    });
});

// ===========================================
// GESTION DES ERREURS
// ===========================================

// 404 pour les routes API non trouvées
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée'
    });
});

// Fallback vers le frontend pour le SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
    console.error('❌ Erreur serveur:', err);

    // Ne pas exposer les détails en production
    const message = config.isDev 
        ? err.message 
        : 'Une erreur est survenue';

    res.status(err.status || 500).json({
        success: false,
        error: message
    });
});

// ===========================================
// DÉMARRAGE DU SERVEUR
// ===========================================

async function startServer() {
    try {
        // Initialiser la base de données
        console.log('📦 Initialisation de la base de données...');
        initializeTables();

        // Initialiser l'arbre de décision
        await initializeDecisionTree();

        // Contrôle de cohérence arbre ↔ IGDB (non bloquant, nécessite les creds Twitch)
        if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
            validateTreeSlugs().catch(err =>
                console.warn('⚠️ Validation des slugs IGDB impossible:', err.message));
        }

        // Créer le compte admin si absent (important pour les déploiements cloud)
        await ensureAdminAccount();

        // Nettoyage automatique des IPs anciennes (conformité RGPD)
        console.log('🧹 Nettoyage automatique des IPs anciennes (RGPD)...');
        try {
            const cleanupResult = runFullCleanup();
            if (cleanupResult.totalDeleted > 0) {
                console.log(`✅ ${cleanupResult.totalDeleted} IP(s) supprimée(s) automatiquement`);
            } else {
                console.log('✅ Aucune IP à supprimer');
            }
        } catch (error) {
            console.error('⚠️ Erreur lors du nettoyage automatique:', error.message);
        }

        // Démarrer le serveur
        app.listen(config.port, () => {
            console.log('');
            console.log('🎮 ═══════════════════════════════════════════');
            console.log('   AKINATOR TWITCH WEB - Serveur démarré');
            console.log('═══════════════════════════════════════════════');
            console.log(`   🌐 URL: http://localhost:${config.port}`);
            console.log(`   📡 API: http://localhost:${config.port}/api`);
            console.log(`   🔧 Mode: ${config.nodeEnv}`);
            console.log('═══════════════════════════════════════════════');
            console.log('');
        });

    } catch (error) {
        console.error('❌ Erreur au démarrage:', error);
        process.exit(1);
    }
}

/**
 * Crée le compte admin au démarrage si absent (déploiements cloud avec DB éphémère)
 */
async function ensureAdminAccount() {
    const { queries } = require('./services/database');
    const bcrypt = require('bcrypt');
    const { v4: uuidv4 } = require('uuid');

    const adminUsername = process.env.ADMIN_USERNAME || 'Akinator';
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
        console.warn('⚠️ ADMIN_PASSWORD non défini : création du compte admin ignorée.');
        console.warn('   Définissez ADMIN_USERNAME / ADMIN_PASSWORD dans l\'environnement.');
        return;
    }

    const existing = queries.users.findByUsername.get(adminUsername);
    if (existing) {
        // Vérifier qu'il est bien admin
        if (!existing.is_admin) {
            require('./services/database').db
                .prepare('UPDATE users SET is_admin = 1 WHERE username = ?')
                .run(adminUsername);
            console.log(`✅ Compte ${adminUsername} promu admin`);
        } else {
            console.log(`✅ Compte admin "${adminUsername}" existant`);
        }
        return;
    }

    const hash = await bcrypt.hash(adminPassword, 12);
    const id = uuidv4();
    queries.users.create.run(id, adminUsername, hash, 999, null);
    require('./services/database').db
        .prepare('UPDATE users SET is_admin = 1, tokens = 999 WHERE id = ?')
        .run(id);
    console.log(`✅ Compte admin "${adminUsername}" créé automatiquement`);
}

/**
 * Initialise l'arbre de décision avec des données par défaut
 */
async function initializeDecisionTree() {
    const { queries } = require('./services/database');
    const tree = queries.tree;
    
    // Vérifier si l'arbre existe déjà
    const existing = tree.getAll.all();
    if (existing.length > 0) {
        console.log(`✅ Arbre de décision: ${existing.length} nœuds`);
        return;
    }

    console.log('🌳 Création de l\'arbre de décision...');

    // Niveau 0: Genres
    const genres = [
        { text: 'Action', slug: 'action' },
        { text: 'Aventure', slug: 'adventure' },
        { text: 'RPG', slug: 'role-playing-rpg' },
        { text: 'FPS / Shooter', slug: 'shooter' },
        { text: 'Sport', slug: 'sport' },
        { text: 'Stratégie', slug: 'strategy' },
        { text: 'Simulation', slug: 'simulator' },
        { text: 'Puzzle', slug: 'puzzle' },
        { text: 'Horreur', slug: 'horror' },
        { text: 'Indie', slug: 'indie' }
    ];

    // Niveau 1: Plateformes
    const platforms = [
        { text: 'PC', slug: 'win' },
        { text: 'PlayStation', slug: 'playstation' },
        { text: 'Xbox', slug: 'xbox' },
        { text: 'Nintendo Switch', slug: 'switch' },
        { text: 'Mobile', slug: 'mobile' }
    ];

    // Niveau 2: Thèmes
    const themes = [
        { text: 'Science-Fiction', slug: 'science-fiction' },
        { text: 'Fantasy', slug: 'fantasy' },
        { text: 'Guerre', slug: 'warfare' },
        { text: 'Survie', slug: 'survival' },
        { text: 'Open World', slug: 'open-world' },
        { text: 'Post-Apocalyptique', slug: 'post-apocalyptic' }
    ];

    // Niveau 3: Modes de jeu
    const gameModes = [
        { text: 'Solo', slug: 'single-player' },
        { text: 'Multijoueur', slug: 'multiplayer' },
        { text: 'Coop', slug: 'co-operative' },
        { text: 'Battle Royale', slug: 'battle-royale' }
    ];

    // Insérer les genres (parent_id = 0)
    for (const genre of genres) {
        const result = tree.insert.run(genre.text, genre.slug, 0, 1, 'genre');
        const genreId = result.lastInsertRowid;

        // Insérer les plateformes sous chaque genre
        for (const platform of platforms) {
            const platResult = tree.insert.run(platform.text, platform.slug, genreId, 2, 'platform');
            const platformId = platResult.lastInsertRowid;

            // Insérer les thèmes sous chaque plateforme (seulement pour certains genres)
            if (['action', 'adventure', 'role-playing-rpg', 'shooter'].includes(genre.slug)) {
                for (const theme of themes) {
                    const themeResult = tree.insert.run(theme.text, theme.slug, platformId, 3, 'theme');
                    const themeId = themeResult.lastInsertRowid;

                    // Insérer les modes de jeu
                    for (const mode of gameModes) {
                        tree.insert.run(mode.text, mode.slug, themeId, 4, 'game_mode');
                    }
                }
            }
        }
    }

    const total = tree.getAll.all().length;
    console.log(`✅ Arbre de décision créé: ${total} nœuds`);
}

/**
 * Vérifie que chaque slug de l'arbre est résoluble côté IGDB (statique puis
 * dynamique). Warn uniquement — ne bloque jamais le démarrage.
 */
async function validateTreeSlugs() {
    const { queries } = require('./services/database');
    const { resolveFilters } = require('./services/igdbFilters');
    const { resolveSlugDynamic } = require('./services/igdb');

    const nodes = queries.tree.getAll.all().filter(n => n.slug_igdb);
    const filters = nodes.map(n => ({ filterType: n.filter_type, slug: n.slug_igdb, text: n.question_text }));
    const { ignored } = await resolveFilters(filters, resolveSlugDynamic);

    if (ignored.length > 0) {
        console.warn(`⚠️ Arbre de décision: ${ignored.length} slug(s) irrésoluble(s) côté IGDB — ces filtres seront ignorés en partie: ${[...new Set(ignored)].join(', ')}`);
    } else {
        console.log('✅ Arbre de décision: tous les slugs sont résolubles côté IGDB');
    }
}

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
    console.log('\n👋 Arrêt du serveur...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Arrêt du serveur...');
    process.exit(0);
});

// Démarrer uniquement si lancé directement (pas en test)
if (require.main === module) {
    startServer();
}

module.exports = { app, initializeDecisionTree, validateTreeSlugs };
