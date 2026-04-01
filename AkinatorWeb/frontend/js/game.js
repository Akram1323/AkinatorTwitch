/**
 * Game Logic - Logique du jeu Akinator
 * Gestion de l'arbre de décision et des recommandations
 * 
 * @author AkinatorTwitch Team
 * @version 2.1
 */

var Game = {
    gameId: null,
    currentFilters: [],
    history: [],
    isPlaying: false,
    
    /**
     * Démarre une nouvelle partie
     */
    start: async function() {
        var self = this;
        
        try {
            showLoading('Démarrage de la partie...');
            
            // Vérifier si connecté
            if (!API.token) {
                hideLoading();
                showToast('Connectez-vous pour jouer', 'warning');
                showLoginModal();
                return;
            }

            // Appeler l'API pour démarrer
            var response = await API.startGame();
            
            if (!response.success) {
                throw new Error(response.error);
            }

            // Initialiser l'état
            self.gameId = response.data.gameId;
            self.currentFilters = [];
            self.history = [];
            self.isPlaying = true;

            // Mettre à jour les jetons
            updateTokenDisplay(response.data.remainingTokens);

            // Afficher la section jeu
            showGameSection();
            
            // Afficher les premières options
            self.displayQuestion(
                response.data.question,
                response.data.options
            );

            hideLoading();
            showToast('Partie lancée ! Bonne chance', 'success');

        } catch (error) {
            hideLoading();
            
            if (error.message && (error.message.indexOf('Jetons insuffisants') !== -1 || error.message.indexOf('insuffisants') !== -1)) {
                showToast('Vous n\'avez plus de jetons ! Allez dans la boutique.', 'error');
                showShopSection();
            } else {
                showToast(error.message || 'Erreur lors du démarrage', 'error');
            }
        }
    },

    /**
     * Affiche une question avec ses options
     */
    displayQuestion: function(questionText, options) {
        var self = this;
        var questionEl = document.getElementById('questionText');
        var optionsGrid = document.getElementById('optionsGrid');
        var recommendBtn = document.getElementById('recommendBtn');
        var backBtn = document.getElementById('backBtn');

        // Animation de sortie
        questionEl.style.opacity = '0';
        optionsGrid.style.opacity = '0';

        setTimeout(function() {
            // Mettre à jour le texte
            questionEl.textContent = questionText;

            // Générer les boutons d'options
            optionsGrid.innerHTML = '';
            options.forEach(function(opt) {
                var btn = document.createElement('button');
                btn.className = 'option-btn';
                // Utiliser textContent pour éviter XSS
                var span = document.createElement('span');
                span.textContent = opt.text;
                btn.appendChild(span);
                btn.addEventListener('click', function() {
                    self.selectOption(opt.id, opt.text, opt.slug || '', opt.type || '');
                });
                optionsGrid.appendChild(btn);
            });

            // Afficher/masquer les boutons
            backBtn.style.display = self.history.length > 0 ? 'block' : 'none';
            recommendBtn.style.display = self.currentFilters.length > 0 ? 'block' : 'none';

            // Mettre à jour le breadcrumb
            self.updateBreadcrumb();

            // Mettre à jour la progress bar
            self.updateProgress();

            // Animation d'entrée
            questionEl.style.opacity = '1';
            optionsGrid.style.opacity = '1';
        }, 200);
    },

    /**
     * Sélectionne une option
     */
    selectOption: async function(nodeId, text, slug, type) {
        var self = this;
        
        try {
            showLoading('Chargement...');

            // Sauvegarder l'état actuel dans l'historique
            self.history.push({
                filters: self.currentFilters.slice(),
                nodeId: nodeId
            });

            // Appeler l'API
            var response = await API.choose(self.gameId, nodeId, self.currentFilters);

            if (!response.success) {
                throw new Error(response.error);
            }

            // Mettre à jour les filtres
            self.currentFilters = response.data.filters;

            hideLoading();

            // Si c'est la fin, afficher les recommandations
            if (response.data.isEnd) {
                await self.showRecommendations();
            } else {
                // Sinon, afficher la question suivante
                self.displayQuestion(
                    response.data.question,
                    response.data.options
                );
            }

        } catch (error) {
            hideLoading();
            showToast(error.message || 'Erreur', 'error');
        }
    },

    /**
     * Revient à l'étape précédente
     */
    goBack: async function() {
        var self = this;
        
        if (self.history.length === 0) return;

        var previousState = self.history.pop();
        self.currentFilters = previousState.filters;

        try {
            showLoading('Retour...');

            var parentNodeId = self.currentFilters.length > 0 
                ? (self.currentFilters[self.currentFilters.length - 1].nodeId || 0)
                : 0;

            var response = await API.getNodeChildren(parentNodeId);

            hideLoading();

            if (response.success) {
                var questions = {
                    0: 'Quel type de jeu recherchez-vous ?',
                    1: 'Sur quelle plateforme ?',
                    2: 'Quel thème vous attire ?',
                    3: 'Quel mode de jeu ?'
                };

                self.displayQuestion(
                    questions[self.currentFilters.length] || 'Que préférez-vous ?',
                    response.data
                );
            }

        } catch (error) {
            hideLoading();
            showToast(error.message || 'Erreur', 'error');
        }
    },

    /**
     * Affiche les recommandations
     */
    showRecommendations: async function() {
        var self = this;
        
        try {
            showLoading('Recherche de jeux...');

            var response = await API.getRecommendations(self.gameId, self.currentFilters);

            hideLoading();

            if (!response.success) {
                throw new Error(response.error);
            }

            self.isPlaying = false;
            self.displayResults(response.data.games, response.data.filters);

        } catch (error) {
            hideLoading();
            showToast(error.message || 'Erreur', 'error');
        }
    },

    /**
     * Affiche les résultats
     */
    displayResults: function(games, filters) {
        document.getElementById('gameSection').style.display = 'none';
        
        var resultsSection = document.getElementById('resultsSection');
        resultsSection.style.display = 'block';

        var filtersText = filters.map(function(f) { return f.text; }).join(' → ');
        document.getElementById('resultsFilters').textContent = 'Critères : ' + filtersText;

        var gamesGrid = document.getElementById('gamesGrid');
        
        if (games.length === 0) {
            gamesGrid.innerHTML = '<div class="no-results"><p>😕 Aucun jeu trouvé avec ces critères.</p><p>Essayez avec des filtres différents !</p></div>';
            return;
        }

        // Utiliser createElement pour éviter XSS
        gamesGrid.innerHTML = '';
        games.forEach(function(game) {
            var card = document.createElement('div');
            card.className = 'game-result-card';
            
            // Cover
            if (game.cover) {
                var img = document.createElement('img');
                img.src = 'https:' + game.cover;
                img.alt = game.name || 'Jeu';
                img.className = 'game-cover';
                card.appendChild(img);
            } else {
                var placeholder = document.createElement('div');
                placeholder.className = 'game-cover-placeholder';
                placeholder.innerHTML = '<i class="fa-solid fa-gamepad placeholder-icon"></i>';
                card.appendChild(placeholder);
            }
            
            var gameInfo = document.createElement('div');
            gameInfo.className = 'game-info';
            
            // Title (échappé)
            var title = document.createElement('h3');
            title.className = 'game-title';
            title.textContent = game.name || 'Sans titre';
            gameInfo.appendChild(title);
            
            // Rating
            var ratingDiv = document.createElement('div');
            ratingDiv.className = 'game-rating';
            var ratingBar = document.createElement('div');
            ratingBar.className = 'rating-bar';
            var ratingFill = document.createElement('div');
            ratingFill.className = 'rating-fill';
            ratingFill.style.width = (game.rating || 0) + '%';
            ratingBar.appendChild(ratingFill);
            ratingDiv.appendChild(ratingBar);
            var ratingValue = document.createElement('span');
            ratingValue.className = 'rating-value';
            ratingValue.textContent = (game.rating || 0) + '%';
            ratingDiv.appendChild(ratingValue);
            gameInfo.appendChild(ratingDiv);
            
            // Meta (year + genres)
            var meta = document.createElement('p');
            meta.className = 'game-meta';
            var metaText = [];
            if (game.releaseYear) metaText.push(game.releaseYear);
            if (game.genres && game.genres.length > 0) {
                metaText.push(' • ' + game.genres.slice(0, 2).join(', '));
            }
            meta.textContent = metaText.join('');
            gameInfo.appendChild(meta);
            
            // Summary (échappé)
            if (game.summary) {
                var summary = document.createElement('p');
                summary.className = 'game-summary';
                summary.textContent = game.summary;
                gameInfo.appendChild(summary);
            }
            
            card.appendChild(gameInfo);
            gamesGrid.appendChild(card);
        });
    },

    /**
     * Met à jour le breadcrumb
     */
    updateBreadcrumb: function() {
        var self = this;
        var breadcrumb = document.getElementById('breadcrumb');
        
        // Utiliser createElement pour éviter XSS
        breadcrumb.innerHTML = '';
        
        var homeItem = document.createElement('span');
        homeItem.className = 'breadcrumb-item' + (self.currentFilters.length === 0 ? ' active' : '');
        homeItem.innerHTML = '<i class="fa-solid fa-house icon-sm"></i> Accueil';
        breadcrumb.appendChild(homeItem);
        
        self.currentFilters.forEach(function(filter, index) {
            var isActive = index === self.currentFilters.length - 1;
            var item = document.createElement('span');
            item.className = 'breadcrumb-item' + (isActive ? ' active' : '');
            item.textContent = filter.text; // Échappement automatique avec textContent
            breadcrumb.appendChild(item);
        });
    },

    /**
     * Met à jour la progress bar
     */
    updateProgress: function() {
        var progressFill = document.getElementById('progressFill');
        var maxDepth = 4;
        var progress = (this.currentFilters.length / maxDepth) * 100;
        progressFill.style.width = Math.min(progress, 100) + '%';
    },

    /**
     * Recommence une nouvelle partie
     */
    restart: function() {
        this.gameId = null;
        this.currentFilters = [];
        this.history = [];
        this.isPlaying = false;
        
        document.getElementById('resultsSection').style.display = 'none';
        this.start();
    },

    /**
     * Retourne à l'accueil
     */
    goHome: function() {
        this.gameId = null;
        this.currentFilters = [];
        this.history = [];
        this.isPlaying = false;
        
        document.getElementById('gameSection').style.display = 'none';
        document.getElementById('resultsSection').style.display = 'none';
        document.getElementById('heroSection').style.display = 'flex';
    }
};

console.log('🎮 Game.js chargé');
