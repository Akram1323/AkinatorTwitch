/**
 * Routes du jeu Akinator
 * Gestion des parties et de l'arbre de décision
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { queries } = require('../services/database');
const igdb = require('../services/igdb');
const { authenticateToken, optionalAuth } = require('../middleware/security');

const router = express.Router();

/**
 * GET /api/game/tree
 * Récupère l'arbre de décision complet
 */
router.get('/tree', (req, res) => {
    try {
        const nodes = queries.tree.getAll.all();
        
        // Construire l'arbre hiérarchique
        const buildTree = (parentId = 0) => {
            return nodes
                .filter(node => node.parent_id === parentId)
                .map(node => ({
                    id: node.id,
                    text: node.question_text,
                    slug: node.slug_igdb,
                    type: node.filter_type,
                    children: buildTree(node.id)
                }));
        };

        const treeData = buildTree();

        res.json({
            success: true,
            data: treeData
        });

    } catch (error) {
        console.error('Erreur tree:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération de l\'arbre'
        });
    }
});

/**
 * GET /api/game/node/:id/children
 * Récupère les enfants d'un nœud
 */
router.get('/node/:id/children', (req, res) => {
    try {
        const parentId = parseInt(req.params.id) || 0;
        const children = queries.tree.getChildren.all(parentId);

        res.json({
            success: true,
            data: children.map(node => ({
                id: node.id,
                text: node.question_text,
                slug: node.slug_igdb,
                type: node.filter_type,
                    hasChildren: queries.tree.getChildren.all(node.id).length > 0
            }))
        });

    } catch (error) {
        console.error('Erreur children:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des options'
        });
    }
});

/**
 * POST /api/game/start
 * Démarre une nouvelle partie (consomme un jeton)
 */
router.post('/start', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }

        // Vérifier les jetons
        if (user.tokens <= 0) {
            return res.status(402).json({
                success: false,
                error: 'Jetons insuffisants',
                tokensNeeded: 1,
                currentTokens: 0
            });
        }

        // Consommer un jeton
        queries.users.updateTokens.run(-1, user.id);

        // Créer la partie
        const gameId = uuidv4();
        queries.games.create.run(gameId, user.id, '[]');

        // Incrémenter le compteur de parties
        queries.users.incrementGames.run(user.id);

        // Récupérer les options de départ (niveau 0)
        const rootOptions = queries.tree.getChildren.all(0);

        console.log(`🎮 Nouvelle partie: ${user.username} (${gameId})`);

        res.json({
            success: true,
            data: {
                gameId,
                remainingTokens: user.tokens - 1,
                options: rootOptions.map(node => ({
                    id: node.id,
                    text: node.question_text,
                    slug: node.slug_igdb,
                    type: node.filter_type
                })),
                question: 'Quel type de jeu recherchez-vous ?'
            }
        });

    } catch (error) {
        console.error('Erreur start:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors du démarrage de la partie'
        });
    }
});

/**
 * POST /api/game/choose
 * Enregistre un choix et retourne les options suivantes
 */
router.post('/choose', optionalAuth, (req, res) => {
    try {
        const { gameId, nodeId, currentFilters } = req.body;

        if (!nodeId) {
            return res.status(400).json({
                success: false,
                error: 'nodeId requis'
            });
        }

        // Si un utilisateur est authentifié et qu'un gameId est fourni, vérifier la propriété (protection IDOR)
        if (req.user && gameId) {
            const game = queries.games.findById.get(gameId);
            if (!game) {
                return res.status(404).json({
                    success: false,
                    error: 'Partie non trouvée'
                });
            }
            if (game.user_id !== req.user.id) {
                return res.status(403).json({
                    success: false,
                    error: 'Accès non autorisé à cette partie'
                });
            }
        }

        // Récupérer le nœud sélectionné
        const node = queries.tree.getById.get(nodeId);
        if (!node) {
            return res.status(404).json({
                success: false,
                error: 'Option non trouvée'
            });
        }

        // Récupérer les enfants
        const children = queries.tree.getChildren.all(nodeId);

        // Ajouter le filtre actuel
        const filters = currentFilters || [];
        if (node.slug_igdb) {
            filters.push({
                type: node.filter_type,
                slug: node.slug_igdb,
                text: node.question_text
            });
        }

        // S'il n'y a plus d'enfants, c'est la fin
        if (children.length === 0) {
            return res.json({
                success: true,
                data: {
                    isEnd: true,
                    filters,
                    message: 'Recherche des jeux correspondants...'
                }
            });
        }

        // Déterminer la question suivante
        const questions = {
            'genre': 'Sur quelle plateforme ?',
            'platform': 'Quel thème vous attire ?',
            'theme': 'Quel mode de jeu ?',
            'game_mode': 'Affiner encore ?'
        };

        const nextType = children[0]?.filter_type || 'other';
        const question = questions[nextType] || 'Que préférez-vous ?';

        res.json({
            success: true,
            data: {
                isEnd: false,
                filters,
                question,
                options: children.map(child => ({
                    id: child.id,
                    text: child.question_text,
                    slug: child.slug_igdb,
                    type: child.filter_type,
                    hasChildren: queries.tree.getChildren.all(child.id).length > 0
                }))
            }
        });

    } catch (error) {
        console.error('Erreur choose:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors du traitement du choix'
        });
    }
});

/**
 * POST /api/game/recommend
 * Récupère les recommandations de jeux basées sur les filtres
 */
router.post('/recommend', optionalAuth, async (req, res) => {
    try {
        const { gameId, filters } = req.body;

        if (!filters || filters.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Filtres requis'
            });
        }

        // Si un utilisateur est authentifié et qu'un gameId est fourni, vérifier la propriété (protection IDOR)
        if (req.user && gameId) {
            const game = queries.games.findById.get(gameId);
            if (!game) {
                return res.status(404).json({
                    success: false,
                    error: 'Partie non trouvée'
                });
            }
            if (game.user_id !== req.user.id) {
                return res.status(403).json({
                    success: false,
                    error: 'Accès non autorisé à cette partie'
                });
            }
        }

        // Transformer les filtres pour le service IGDB
        const formattedFilters = filters.map(filter => ({
            filterType: filter.type,
            slug: filter.slug,
            text: filter.text
        }));

        console.log('🔍 Recherche IGDB avec filtres:', formattedFilters);

        // Rechercher sur IGDB
        let recommendedGames = [];
        
        try {
            recommendedGames = await igdb.searchGamesByFilters(formattedFilters);
        } catch (igdbError) {
            console.error('❌ Erreur IGDB:', igdbError.message);
            // Fallback: jeux populaires si l'API échoue
            recommendedGames = await igdb.getPopularGames(10);
        }

        // Si aucun résultat, récupérer des jeux populaires
        if (recommendedGames.length === 0) {
            console.log('⚠️ Aucun résultat, récupération jeux populaires...');
            recommendedGames = await igdb.getPopularGames(10);
        }

        // Sauvegarder les résultats si partie en cours (et vérifiée ci-dessus)
        if (gameId) {
            try {
                queries.games.complete.run(JSON.stringify(recommendedGames.map(g => g.name)), gameId);
            } catch (e) {
                console.warn('⚠️ Impossible de sauvegarder les résultats');
            }
        }

        res.json({
            success: true,
            data: {
                games: recommendedGames,
                filters: filters,
                count: recommendedGames.length
            }
        });

    } catch (error) {
        console.error('Erreur recommend:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la recherche de jeux'
        });
    }
});

/**
 * GET /api/game/history
 * Récupère l'historique des parties de l'utilisateur
 */
router.get('/history', authenticateToken, (req, res) => {
    try {
        const userGames = queries.games.findByUser.all(req.user.id);

        res.json({
            success: true,
            data: userGames.map(game => {
                // Parsing sécurisé avec gestion d'erreur
                let filters = [];
                let games = [];
                
                try {
                    filters = JSON.parse(game.filters_used || '[]');
                } catch (e) {
                    console.warn(`⚠️ Erreur parsing filters pour partie ${game.id}:`, e.message);
                    filters = [];
                }
                
                try {
                    games = JSON.parse(game.games_recommended || '[]');
                } catch (e) {
                    console.warn(`⚠️ Erreur parsing games pour partie ${game.id}:`, e.message);
                    games = [];
                }
                
                return {
                    id: game.id,
                    filters,
                    games,
                    startedAt: game.started_at,
                    completedAt: game.completed_at
                };
            })
        });

    } catch (error) {
        console.error('Erreur history:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération de l\'historique'
        });
    }
});

/**
 * GET /api/game/leaderboard
 * Classement des 10 meilleurs joueurs
 */
router.get('/leaderboard', (req, res) => {
    try {
        const leaderboard = queries.users.getLeaderboard.all();
        res.json({
            success: true,
            data: leaderboard.map((user, index) => ({
                rank: index + 1,
                username: user.username,
                totalGames: user.total_games,
                memberSince: user.created_at
            }))
        });
    } catch (error) {
        console.error('Erreur leaderboard:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération du classement'
        });
    }
});

/**
 * GET /api/game/igdb-status
 * Vérifie la connexion à l'API IGDB
 */
router.get('/igdb-status', async (req, res) => {
    try {
        const isConnected = await igdb.testConnection();
        
        res.json({
            success: true,
            data: {
                connected: isConnected,
                message: isConnected 
                    ? 'API IGDB connectée' 
                    : 'API IGDB non disponible - vérifiez TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET'
            }
        });
    } catch (error) {
        res.json({
            success: false,
            data: {
                connected: false,
                message: error.message
            }
        });
    }
});

/**
 * GET /api/game/popular
 * Récupère les jeux populaires
 */
router.get('/popular', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const games = await igdb.getPopularGames(Math.min(limit, 20));
        
        res.json({
            success: true,
            data: games
        });
    } catch (error) {
        console.error('Erreur popular:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des jeux populaires'
        });
    }
});

module.exports = router;
