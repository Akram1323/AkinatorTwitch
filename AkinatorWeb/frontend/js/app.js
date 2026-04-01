/**
 * Application principale - Initialisation et UI
 * Utilise addEventListener pour la compatibilité CSP
 * 
 * @author AkinatorTwitch Team
 * @version 2.2
 */

// État global
let currentUser = null;
let selectedPack = null;
let selectedCrypto = null;

// ══════════════════════════════════════════════════════════════
// Sécurité : Fonction d'échappement HTML (protection XSS)
// ══════════════════════════════════════════════════════════════
function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Prix des packs
const PACK_PRICES = {
    'pack_10': { tokens: 10, btc: '0.00005', eth: '0.0005', eurApprox: '0.50€' },
    'pack_25': { tokens: 25, btc: '0.0001', eth: '0.001', eurApprox: '1€' },
    'pack_50': { tokens: 50, btc: '0.00018', eth: '0.0018', eurApprox: '1.80€' },
    'pack_100': { tokens: 100, btc: '0.0003', eth: '0.003', eurApprox: '3€' }
};

// Adresses crypto
const CRYPTO_ADDRESSES = {
    btc: 'bc1qkm9qyw73f5n5fpj8etgytqczl3hjnafy6xrvs0',
    eth: '0x1cE68c57A2bA325CD61dD248159957130132EF05'
};

// ══════════════════════════════════════════════════════════════
// Initialisation
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async function() {
    console.log('🎮 Akinator Twitch Web - Initialisation...');
    
    attachEventListeners();
    
    try {
        var health = await API.healthCheck();
        console.log('✅ Backend connecté:', health.message);
    } catch (error) {
        console.error('❌ Backend non disponible:', error);
        showToast('Serveur non disponible. Vérifiez que le backend est lancé.', 'error');
        return;
    }

    if (API.token) {
        await loadUserProfile();
        // Récupérer le token CSRF après chargement du profil
        try {
            await API.refreshCSRFToken();
        } catch (e) {
            console.warn('⚠️ CSRF token non disponible:', e);
        }
    }

    createParticles();
    initSpeechBubbles();
    
    console.log('🎮 Application prête !');
});

// ══════════════════════════════════════════════════════════════
// Event Listeners
// ══════════════════════════════════════════════════════════════

function attachEventListeners() {
    // Header buttons
    document.getElementById('logoBtn').addEventListener('click', goHome);
    document.getElementById('shopBtn').addEventListener('click', showShopSection);
    document.getElementById('loginBtn').addEventListener('click', showLoginModal);
    document.getElementById('registerBtn').addEventListener('click', showRegisterModal);
    // logoutBtn supprimé du header
    
    // Admin button
    var adminBtn = document.getElementById('adminBtn');
    if (adminBtn) {
        adminBtn.addEventListener('click', showAdminSection);
    }
    
    // Profil - clic sur le pseudo
    document.getElementById('userName').addEventListener('click', showProfileModal);
    
    // Admin buttons
    var backHomeFromAdminBtn = document.getElementById('backHomeFromAdminBtn');
    if (backHomeFromAdminBtn) {
        backHomeFromAdminBtn.addEventListener('click', goHome);
    }
    var cleanupIPsBtn = document.getElementById('cleanupIPsBtn');
    if (cleanupIPsBtn) {
        cleanupIPsBtn.addEventListener('click', handleCleanupIPs);
    }
    var refreshUsersBtn = document.getElementById('refreshUsersBtn');
    if (refreshUsersBtn) {
        refreshUsersBtn.addEventListener('click', loadAdminData);
    }
    
    // Hero buttons
    document.getElementById('startGameBtn').addEventListener('click', function() {
        Game.start();
    });
    document.getElementById('leaderboardBtn').addEventListener('click', showLeaderboard);
    
    // Shop buttons
    document.getElementById('backHomeBtn').addEventListener('click', goHome);
    document.getElementById('claimDailyBtn').addEventListener('click', claimDailyTokens);
    
    // Crypto selection
    document.getElementById('createBTCPayInvoiceBtn').addEventListener('click', createBTCPayInvoice);
    
    // Pack selection
    document.querySelectorAll('.shop-pack').forEach(function(pack) {
        pack.addEventListener('click', function() {
            selectPack(this.dataset.pack, this);
        });
    });
    
    // Game buttons
    document.getElementById('backBtn').addEventListener('click', function() {
        Game.goBack();
    });
    document.getElementById('recommendBtn').addEventListener('click', function() {
        Game.showRecommendations();
    });
    
    // Results buttons
    document.getElementById('restartGameBtn').addEventListener('click', function() {
        Game.restart();
    });
    document.getElementById('homeFromResultsBtn').addEventListener('click', goHome);
    
    // Forms
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('registerForm').addEventListener('submit', handleRegister);
    
    // Modal switches
    document.getElementById('switchToRegister').addEventListener('click', function(e) {
        e.preventDefault();
        showRegisterModal();
    });
    document.getElementById('switchToLogin').addEventListener('click', function(e) {
        e.preventDefault();
        showLoginModal();
    });
    
    // Modal close buttons
    document.querySelectorAll('[data-close]').forEach(function(el) {
        el.addEventListener('click', function() {
            closeModal(this.dataset.close);
        });
    });
    
    // Password toggle buttons
    document.querySelectorAll('.password-toggle').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var targetId = this.dataset.target;
            var input = document.getElementById(targetId);
            var icon = this.querySelector('i');
            if (input.type === 'password') {
                input.type = 'text';
                if (icon) {
                    icon.classList.remove('fa-eye');
                    icon.classList.add('fa-eye-slash');
                }
            } else {
                input.type = 'password';
                if (icon) {
                    icon.classList.remove('fa-eye-slash');
                    icon.classList.add('fa-eye');
                }
            }
        });
    });
    
    // Profile modal buttons
    document.getElementById('profileClaimDaily').addEventListener('click', function() {
        claimDailyTokens();
        closeModal('profileModal');
    });
    document.getElementById('goToShopFromProfile').addEventListener('click', function() {
        closeModal('profileModal');
        showShopSection();
    });
    
    // Profile tabs
    document.querySelectorAll('.profile-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            var tabId = this.dataset.tab;

            // Update active tab
            document.querySelectorAll('.profile-tab').forEach(function(t) {
                t.classList.remove('active');
            });
            this.classList.add('active');

            // Show corresponding content
            document.querySelectorAll('.profile-tab-content').forEach(function(content) {
                content.classList.remove('active');
            });
            document.getElementById('tab-' + tabId).classList.add('active');

            // Load history when tab opened
            if (tabId === 'history') {
                loadGameHistory();
            }
        });
    });
    
    // Change password form
    document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);

    // Forgot password
    document.getElementById('forgotPasswordLink').addEventListener('click', function(e) {
        e.preventDefault();
        closeModal('loginModal');
        showModal('forgotPasswordModal');
        document.getElementById('forgotPasswordForm').reset();
        document.getElementById('forgotPasswordError').style.display = 'none';
    });
    document.getElementById('forgotPasswordForm').addEventListener('submit', handleForgotPassword);
    
    // Logout from profile
    document.getElementById('logoutFromProfile').addEventListener('click', function() {
        closeModal('profileModal');
        logout();
    });
    
    // A2F toggle
    document.getElementById('toggleA2F').addEventListener('click', setupA2F);
    
    // A2F setup modal
    document.getElementById('verifyA2FSetup').addEventListener('click', verifyA2FSetup);
    
    // A2F login modal
    document.getElementById('verifyA2FLogin').addEventListener('click', verifyA2FLogin);
    
    // Avatar upload
    document.getElementById('avatarInput').addEventListener('change', uploadAvatar);
    
    // Legal pages
    document.getElementById('privacyPolicyLink').addEventListener('click', function(e) {
        e.preventDefault();
        showPrivacyPolicy();
    });
    document.getElementById('dataProcessingLink').addEventListener('click', function(e) {
        e.preventDefault();
        showDataProcessing();
    });
    
    // Escape key to close modals
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(function(modal) {
                closeModal(modal.id);
            });
        }
    });
    
    console.log('✅ Event listeners attachés');
}

// ══════════════════════════════════════════════════════════════
// Profil
// ══════════════════════════════════════════════════════════════

function showProfileModal() {
    if (!currentUser) return;
    
    document.getElementById('profileUsername').textContent = currentUser.username;
    document.getElementById('profileTokens').textContent = currentUser.tokens;
    document.getElementById('profileGames').textContent = currentUser.totalGames || 0;
    
    // Avatar
    var avatarImg = document.getElementById('profileAvatarImg');
    if (currentUser.avatarUrl) {
        avatarImg.src = currentUser.avatarUrl + '?t=' + Date.now();
    } else {
        avatarImg.src = 'images/profile-removebg-preview.png';
    }
    
    // Formater la date
    if (currentUser.createdAt) {
        var date = new Date(currentUser.createdAt);
        document.getElementById('profileDate').textContent = date.toLocaleDateString('fr-FR');
    } else {
        document.getElementById('profileDate').textContent = 'Récemment';
    }
    
    // Bouton claim daily
    var dailySection = document.getElementById('profileDailySection');
    var claimBtn = document.getElementById('profileClaimDaily');
    if (currentUser.canClaimDaily) {
        dailySection.style.display = 'block';
        claimBtn.disabled = false;
    } else {
        dailySection.style.display = 'none';
    }
    
    // A2F status
    updateA2FStatus();
    
    // Reset to first tab
    document.querySelectorAll('.profile-tab').forEach(function(t) {
        t.classList.remove('active');
    });
    document.querySelector('.profile-tab[data-tab="overview"]').classList.add('active');
    
    document.querySelectorAll('.profile-tab-content').forEach(function(c) {
        c.classList.remove('active');
    });
    document.getElementById('tab-overview').classList.add('active');
    
    // Reset password form
    document.getElementById('changePasswordForm').reset();
    document.getElementById('passwordError').style.display = 'none';

    // Afficher le champ A2F si l'utilisateur a l'A2F activé
    var a2fGroup = document.getElementById('changePasswordA2FGroup');
    if (a2fGroup) {
        a2fGroup.style.display = currentUser.a2fEnabled ? 'block' : 'none';
    }

    // Reset A2F code
    document.getElementById('a2fVerifyCode').value = '';
    
    showModal('profileModal');
}

// ══════════════════════════════════════════════════════════════
// Authentification
// ══════════════════════════════════════════════════════════════

async function loadUserProfile() {
    try {
        var response = await API.getProfile();
        if (response.success) {
            currentUser = response.data;
            updateUIForLoggedInUser();
            
            // dailyBonus supprimé de la page d'accueil
        }
    } catch (error) {
        console.error('Token invalide, déconnexion...', error);
        API.logout();
        currentUser = null;
    }
}

function updateUIForLoggedInUser() {
    document.getElementById('authButtons').style.display = 'none';
    document.getElementById('userMenu').style.display = 'flex';
    document.getElementById('tokenDisplay').style.display = 'flex';
    
    document.getElementById('userNameText').textContent = currentUser.username;
    var headerAvatar = document.getElementById('headerAvatar');
    if (headerAvatar) {
        headerAvatar.src = currentUser.avatarUrl
            ? currentUser.avatarUrl + '?t=' + Date.now()
            : 'images/profile-removebg-preview.png';
    }
    document.getElementById('tokenCount').textContent = currentUser.tokens;
    document.getElementById('shopTokenBalance').textContent = currentUser.tokens;
    
    // Afficher le bouton admin si l'utilisateur est admin
    var adminBtn = document.getElementById('adminBtn');
    if (adminBtn) {
        adminBtn.style.display = currentUser.isAdmin ? 'inline-flex' : 'none';
    }
    
    // Gestion du bouton daily dans le profil uniquement
    var claimDailyBtn = document.getElementById('claimDailyBtn');
    
    if (claimDailyBtn) {
        if (currentUser.canClaimDaily) {
            claimDailyBtn.disabled = false;
            claimDailyBtn.textContent = 'Récupérer 3 jetons';
        } else {
            claimDailyBtn.disabled = true;
            claimDailyBtn.textContent = 'Déjà récupéré aujourd\'hui';
        }
    }
}

function updateUIForLoggedOutUser() {
    document.getElementById('authButtons').style.display = 'flex';
    document.getElementById('userMenu').style.display = 'none';
    document.getElementById('tokenDisplay').style.display = 'none';
    currentUser = null;
}

function updateTokenDisplay(tokens) {
    document.getElementById('tokenCount').textContent = tokens;
    document.getElementById('shopTokenBalance').textContent = tokens;
    if (currentUser) {
        currentUser.tokens = tokens;
    }
}

// ══════════════════════════════════════════════════════════════
// Inscription
// ══════════════════════════════════════════════════════════════

async function handleRegister(event) {
    event.preventDefault();
    
    var username = document.getElementById('regUsername').value.trim();
    var password = document.getElementById('regPassword').value;
    var rgpdConsent = document.getElementById('rgpdConsent').checked;
    var errorDiv = document.getElementById('registerError');
    var submitBtn = document.getElementById('registerSubmitBtn');
    
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';
    
    if (username.length < 3 || username.length > 20) {
        errorDiv.textContent = 'Le nom d\'utilisateur doit faire entre 3 et 20 caractères';
        errorDiv.style.display = 'block';
        return;
    }
    
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        errorDiv.textContent = 'Caractères autorisés : lettres, chiffres et underscore';
        errorDiv.style.display = 'block';
        return;
    }
    
    if (password.length < 8) {
        errorDiv.textContent = 'Le mot de passe doit faire au moins 8 caractères';
        errorDiv.style.display = 'block';
        return;
    }
    
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
        errorDiv.textContent = 'Le mot de passe doit contenir une majuscule, une minuscule et un chiffre';
        errorDiv.style.display = 'block';
        return;
    }
    
    if (!rgpdConsent) {
        errorDiv.textContent = 'Vous devez accepter le traitement de vos données personnelles pour créer un compte';
        errorDiv.style.display = 'block';
        return;
    }

    try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Création...';
        
        var response = await API.register(username, password, rgpdConsent);

        if (response.success) {
            currentUser = response.data.user;
            currentUser.canClaimDaily = false;
            updateUIForLoggedInUser();
            closeModal('registerModal');
            showToast('Bienvenue ' + username + ' ! 3 jetons offerts', 'success');
            document.getElementById('registerForm').reset();
        }
    } catch (error) {
        console.error('Erreur inscription:', error);
        errorDiv.textContent = error.message || 'Erreur lors de l\'inscription';
        errorDiv.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Créer mon compte';
    }
}

// ══════════════════════════════════════════════════════════════
// Mot de passe oublié (récupération via A2F)
// ══════════════════════════════════════════════════════════════

async function handleForgotPassword(event) {
    event.preventDefault();

    var username = document.getElementById('forgotUsername').value.trim();
    var a2fCode = document.getElementById('forgotA2FCode').value.trim();
    var newPassword = document.getElementById('forgotNewPassword').value;
    var confirmPassword = document.getElementById('forgotConfirmPassword').value;
    var errorDiv = document.getElementById('forgotPasswordError');
    var submitBtn = document.getElementById('forgotPasswordSubmitBtn');

    errorDiv.textContent = '';
    errorDiv.style.display = 'none';

    if (!a2fCode || a2fCode.length !== 6) {
        errorDiv.textContent = 'Code A2F invalide (6 chiffres requis)';
        errorDiv.style.display = 'block';
        return;
    }

    if (newPassword.length < 8 || !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
        errorDiv.textContent = 'Mot de passe: min 8 caractères avec majuscule, minuscule et chiffre';
        errorDiv.style.display = 'block';
        return;
    }

    if (newPassword !== confirmPassword) {
        errorDiv.textContent = 'Les mots de passe ne correspondent pas';
        errorDiv.style.display = 'block';
        return;
    }

    try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Réinitialisation...';

        var response = await API.forgotPassword(username, a2fCode, newPassword);

        if (response.success) {
            closeModal('forgotPasswordModal');
            showLoginModal();
            showToast('Mot de passe réinitialisé ! Vous pouvez vous connecter.', 'success');
            document.getElementById('forgotPasswordForm').reset();
        }
    } catch (error) {
        errorDiv.textContent = error.message || 'Erreur lors de la réinitialisation';
        errorDiv.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-lock-open icon"></i> Réinitialiser le mot de passe';
    }
}

// ══════════════════════════════════════════════════════════════
// Connexion
// ══════════════════════════════════════════════════════════════

async function handleLogin(event) {
    event.preventDefault();
    
    var username = document.getElementById('loginUsername').value.trim();
    var password = document.getElementById('loginPassword').value;
    var errorDiv = document.getElementById('loginError');
    var submitBtn = document.getElementById('loginSubmitBtn');
    
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';

    if (!username || !password) {
        errorDiv.textContent = 'Veuillez remplir tous les champs';
        errorDiv.style.display = 'block';
        return;
    }

    try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Connexion...';
        
        var response = await API.login(username, password);

        if (response.success) {
            // Vérifier si A2F est requis
            if (response.requiresA2F) {
                // Stocker le token temporaire pour la vérification A2F
                window.pendingA2FToken = response.data.tempToken;
                closeModal('loginModal');
                showModal('a2fLoginModal');
                document.getElementById('a2fLoginCode').value = '';
                document.getElementById('a2fLoginCode').focus();
                return;
            }
            
            currentUser = response.data.user;
            updateUIForLoggedInUser();
            // Récupérer le token CSRF après inscription
            await API.refreshCSRFToken();
            closeModal('loginModal');
            showToast('Content de vous revoir, ' + username + ' !', 'success');
            document.getElementById('loginForm').reset();
        }
    } catch (error) {
        console.error('Erreur connexion:', error);
        errorDiv.textContent = error.message || 'Identifiants incorrects';
        errorDiv.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Se connecter';
    }
}

async function logout() {
    await API.logout();
    updateUIForLoggedOutUser();
    goHome();
    showToast('Déconnecté avec succès', 'success');
}

// ══════════════════════════════════════════════════════════════
// Changement de mot de passe
// ══════════════════════════════════════════════════════════════

async function handleChangePassword(event) {
    event.preventDefault();

    var currentPassword = document.getElementById('currentPassword').value;
    var newPassword = document.getElementById('newPassword').value;
    var confirmPassword = document.getElementById('confirmPassword').value;
    var a2fCode = document.getElementById('changePasswordA2FCode').value.trim();
    var errorDiv = document.getElementById('passwordError');

    errorDiv.textContent = '';
    errorDiv.style.display = 'none';

    if (newPassword.length < 8) {
        errorDiv.textContent = 'Le nouveau mot de passe doit faire au moins 8 caractères';
        errorDiv.style.display = 'block';
        return;
    }

    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
        errorDiv.textContent = 'Le mot de passe doit contenir une majuscule, une minuscule et un chiffre';
        errorDiv.style.display = 'block';
        return;
    }

    if (newPassword !== confirmPassword) {
        errorDiv.textContent = 'Les mots de passe ne correspondent pas';
        errorDiv.style.display = 'block';
        return;
    }

    if (currentUser && currentUser.a2fEnabled && (!a2fCode || a2fCode.length !== 6)) {
        errorDiv.textContent = 'Code A2F requis (6 chiffres)';
        errorDiv.style.display = 'block';
        return;
    }

    try {
        showLoading('Mise à jour du mot de passe...');

        var response = await API.changePassword(currentPassword, newPassword, a2fCode || undefined);

        hideLoading();

        if (response.success) {
            showToast('Mot de passe mis à jour avec succès !', 'success');
            document.getElementById('changePasswordForm').reset();
        }
    } catch (error) {
        hideLoading();
        errorDiv.textContent = error.message || 'Erreur lors de la mise à jour';
        errorDiv.style.display = 'block';
    }
}

// ══════════════════════════════════════════════════════════════
// Jetons Quotidiens
// ══════════════════════════════════════════════════════════════

async function claimDailyTokens() {
    if (!currentUser) {
        showToast('Connectez-vous pour récupérer vos jetons', 'warning');
        showLoginModal();
        return;
    }

    try {
        showLoading('Récupération des jetons...');
        
        var response = await API.claimDaily();
        
        hideLoading();

        if (response.success) {
            updateTokenDisplay(response.data.newBalance);
            currentUser.canClaimDaily = false;

            // Cacher la section daily dans la boutique (réapparaîtra demain)
            var dailySection = document.getElementById('dailySection');
            if (dailySection) dailySection.style.display = 'none';

            // Cacher la section daily dans le profil
            var profileDailySection = document.getElementById('profileDailySection');
            if (profileDailySection) profileDailySection.style.display = 'none';

            showToast('+3 jetons quotidiens ajoutés ! Revenez demain.', 'success');
        }
    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur lors de la récupération', 'error');
    }
}

// ══════════════════════════════════════════════════════════════
// Boutique
// ══════════════════════════════════════════════════════════════

function showShopSection() {
    if (!currentUser) {
        showToast('Connectez-vous pour accéder à la boutique', 'warning');
        showLoginModal();
        return;
    }
    
    stopSpeechBubbles();
    
    document.getElementById('heroSection').style.display = 'none';
    document.getElementById('gameSection').style.display = 'none';
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('adminSection').style.display = 'none';
    document.getElementById('shopSection').style.display = 'block';
    
    document.getElementById('shopTokenBalance').textContent = currentUser.tokens;
    
    var dailySection = document.getElementById('dailySection');
    if (dailySection) {
        dailySection.style.display = currentUser.canClaimDaily ? 'block' : 'none';
    }

    var claimBtn = document.getElementById('claimDailyBtn');
    if (claimBtn) {
        if (currentUser.canClaimDaily) {
            claimBtn.disabled = false;
            claimBtn.textContent = 'Récupérer 3 jetons';
        } else {
            claimBtn.disabled = true;
            claimBtn.textContent = 'Déjà récupéré aujourd\'hui';
        }
    }
}

function selectPack(packId, element) {
    selectedPack = packId;

    document.querySelectorAll('.shop-pack').forEach(function(el) {
        el.classList.remove('selected');
    });
    element.classList.add('selected');

    // Réinitialiser le flux BTCPay
    stopBTCPayPolling();
    document.getElementById('btcpayCreateSection').style.display = 'block';
    document.getElementById('btcpayInvoiceSection').style.display = 'none';
    document.getElementById('btcpaySpinner').style.display = 'block';
    document.getElementById('btcpayStatusText').textContent = 'En attente du paiement...';
    var btn = document.getElementById('createBTCPayInvoiceBtn');
    btn.disabled = false;
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="18" height="18" style="margin-right:6px;vertical-align:middle;flex-shrink:0;"><rect width="100" height="100" rx="18" fill="rgba(255,255,255,0.9)"/><path d="M68 44c1.2-8-4.9-12.3-13.3-15.2l2.7-10.8-6.6-1.6-2.6 10.6-5.3-1.3 2.6-10.6-6.6-1.6-2.7 10.8-13.3-3.3-1.8 7s4.9 1.1 4.8 1.2c2.7.7 3.2 2.5 3.1 3.9l-7.4 29.7c-.3 1.3-1.6 2.3-3.4 1.8 0 0-4.8-1.2-4.8-1.2L11 71l13 3.3-2.7 10.9 6.6 1.6 2.7-10.9 5.3 1.3-2.7 10.9 6.6 1.6 2.7-10.9c11.1 2.1 19.4.8 22.9-8.8 2.8-8-.1-12.6-5.9-15.6 4.2-1 7.3-3.7 8.5-9.4zM54 67.8c-2 8-15.4 3.7-19.7 2.6l3.5-14c4.4 1.1 18.4 3.3 16.2 11.4zm2-24.1c-1.8 7.2-13 4-16.7 3l3.2-12.8c3.7 1 15.5 2.5 13.5 9.8z" fill="#F7931A"/></svg> Payer avec BTCPay';

    // Afficher le montant
    if (PACK_PRICES[packId]) {
        document.getElementById('btcpayAmountPreview').textContent = PACK_PRICES[packId].eurApprox;
    }

    document.getElementById('paymentSection').style.display = 'block';
    showToast('Pack sélectionné !', 'info');
}

function selectCrypto(crypto) {
    selectedCrypto = crypto;
    
    document.querySelectorAll('.crypto-option').forEach(function(el) {
        el.classList.remove('selected');
    });
    document.getElementById('crypto' + crypto.toUpperCase()).classList.add('selected');
    
    // Afficher le bon panel de paiement
    document.getElementById('btcPayment').style.display = crypto === 'btc' ? 'block' : 'none';
    document.getElementById('ethPayment').style.display = crypto === 'eth' ? 'block' : 'none';
    document.getElementById('btcpayPayment').style.display = crypto === 'btcpay' ? 'block' : 'none';

    // Mettre à jour les montants
    if (selectedPack && PACK_PRICES[selectedPack]) {
        var pack = PACK_PRICES[selectedPack];
        document.getElementById('btcAmount').textContent = pack.btc + ' BTC';
        document.getElementById('ethAmount').textContent = pack.eth + ' ETH';
        document.getElementById('btcpayAmountPreview').textContent = pack.eurApprox;
    }

    // Réinitialiser le panel BTCPay si on change de méthode
    if (crypto !== 'btcpay') {
        stopBTCPayPolling();
    } else {
        document.getElementById('btcpayCreateSection').style.display = 'block';
        document.getElementById('btcpayInvoiceSection').style.display = 'none';
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(function() {
        showToast('Adresse copiée !', 'success');
    }).catch(function() {
        showToast('Erreur lors de la copie', 'error');
    });
}

async function verifyBtcPayment() {
    var txHash = document.getElementById('btcTxHash').value.trim();
    if (!txHash) {
        showToast('Entrez le hash de transaction', 'warning');
        return;
    }
    
    await verifyManualPayment('btc', txHash);
}

async function verifyEthPayment() {
    var txHash = document.getElementById('ethTxHash').value.trim();
    if (!txHash) {
        showToast('Entrez le hash de transaction', 'warning');
        return;
    }
    
    await verifyManualPayment('eth', txHash);
}

async function verifyManualPayment(crypto, txHash) {
    if (!selectedPack) {
        showToast('Sélectionnez un pack d\'abord', 'warning');
        return;
    }
    
    try {
        showLoading('Vérification de la transaction...');
        
        var response = await API.purchaseTokens(selectedPack, txHash);
        
        hideLoading();

        if (response.success) {
            updateTokenDisplay(response.data.newBalance);
            var pack = PACK_PRICES[selectedPack];
            showToast(pack.tokens + ' jetons ajoutés !', 'success');
            
            // Reset
            selectedPack = null;
            selectedCrypto = null;
            document.querySelectorAll('.shop-pack').forEach(function(el) { 
                el.classList.remove('selected'); 
            });
            document.getElementById('paymentSection').style.display = 'none';
            document.getElementById('btcTxHash').value = '';
            document.getElementById('ethTxHash').value = '';
        }

    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur de vérification', 'error');
    }
}

// ══════════════════════════════════════════════════════════════
// BTCPay Server - Paiement crypto automatisé
// ══════════════════════════════════════════════════════════════

var btcpayPollingInterval = null;

function stopBTCPayPolling() {
    if (btcpayPollingInterval) {
        clearInterval(btcpayPollingInterval);
        btcpayPollingInterval = null;
    }
}

async function createBTCPayInvoice() {
    if (!selectedPack) {
        showToast('Sélectionnez un pack d\'abord', 'warning');
        return;
    }
    if (!currentUser) {
        showToast('Connectez-vous pour acheter des jetons', 'warning');
        showLoginModal();
        return;
    }

    var btn = document.getElementById('createBTCPayInvoiceBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin icon"></i> Création en cours...';

    try {
        var response = await API.createBTCPayInvoice(selectedPack);

        if (!response.success) {
            throw new Error(response.error || 'Erreur BTCPay');
        }

        var data = response.data;

        // Afficher la section invoice
        document.getElementById('btcpayCreateSection').style.display = 'none';
        document.getElementById('btcpayInvoiceSection').style.display = 'block';
        document.getElementById('btcpayInvoiceIdDisplay').textContent = data.invoiceId;

        // Afficher le lien checkout si disponible (mode production)
        var checkoutLink = document.getElementById('btcpayCheckoutLink');
        if (data.checkoutLink) {
            checkoutLink.href = data.checkoutLink;
            checkoutLink.style.display = 'flex';
        } else {
            checkoutLink.style.display = 'none';
        }

        if (data.isDemo) {
            document.getElementById('btcpayStatusText').textContent =
                'En attente de validation par un administrateur...';
            showToast('Mode démo : en attente de validation admin', 'info');
        } else {
            document.getElementById('btcpayStatusText').textContent =
                'En attente du paiement sur BTCPay...';
            showToast('Facture créée ! Payez via le lien BTCPay.', 'success');
        }

        // Démarrer le polling du statut
        pollBTCPayStatus(data.invoiceId, data.tokens);

    } catch (error) {
        showToast(error.message || 'Erreur lors de la création de la facture', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt icon"></i> Créer une facture BTCPay';
    }
}

function pollBTCPayStatus(invoiceId, tokens) {
    stopBTCPayPolling();

    var attempts = 0;
    var maxAttempts = 200; // ~10 minutes à 3s d'intervalle

    btcpayPollingInterval = setInterval(async function() {
        attempts++;

        if (attempts > maxAttempts) {
            stopBTCPayPolling();
            document.getElementById('btcpayStatusText').textContent =
                'Délai dépassé. Rechargez la page si vous avez payé.';
            document.getElementById('btcpaySpinner').style.display = 'none';
            return;
        }

        try {
            var response = await API.getBTCPayStatus(invoiceId);

            if (!response.success) return;

            var status = response.data.status;

            var statusMessages = {
                'New':        'En attente du paiement...',
                'Processing': '⏳ Paiement reçu, en attente de confirmation...',
                'Settled':    '✅ Paiement confirmé !',
                'Expired':    '❌ Facture expirée.',
                'Invalid':    '❌ Paiement invalide.'
            };

            var statusEl = document.getElementById('btcpayStatusText');
            if (statusMessages[status]) {
                statusEl.textContent = statusMessages[status];
            }

            if (status === 'Settled') {
                stopBTCPayPolling();
                document.getElementById('btcpaySpinner').style.display = 'none';

                var newBalance = response.data.newBalance || (currentUser ? currentUser.tokens + tokens : null);
                if (newBalance !== null) {
                    updateTokenDisplay(newBalance);
                }

                showToast(tokens + ' jetons ajoutés ! Merci pour votre achat.', 'success');

                // Reset de la section paiement après 2 secondes
                setTimeout(function() {
                    selectedPack = null;
                    selectedCrypto = null;
                    document.querySelectorAll('.shop-pack').forEach(function(el) {
                        el.classList.remove('selected');
                    });
                    document.getElementById('paymentSection').style.display = 'none';
                    document.getElementById('btcpayCreateSection').style.display = 'block';
                    document.getElementById('btcpayInvoiceSection').style.display = 'none';
                    document.getElementById('btcpaySpinner').style.display = 'block';
                    document.getElementById('btcpayStatusText').textContent = 'En attente du paiement...';
                }, 2000);
            }

            if (status === 'Expired' || status === 'Invalid') {
                stopBTCPayPolling();
                document.getElementById('btcpaySpinner').style.display = 'none';
                showToast('Paiement échoué ou expiré. Réessayez.', 'error');

                setTimeout(function() {
                    document.getElementById('btcpayCreateSection').style.display = 'block';
                    document.getElementById('btcpayInvoiceSection').style.display = 'none';
                    document.getElementById('btcpaySpinner').style.display = 'block';
                    var btn = document.getElementById('createBTCPayInvoiceBtn');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-bolt icon"></i> Créer une nouvelle facture';
                }, 2000);
            }

        } catch (e) {
            // Erreur réseau temporaire : on continue le polling
            console.warn('BTCPay polling error:', e.message);
        }
    }, 3000);
}

async function connectWallet() {
    try {
        showLoading('Connexion au wallet...');
        
        var address = await Wallet.connect();
        
        hideLoading();

        document.getElementById('connectWalletBtn').style.display = 'none';
        document.getElementById('walletConnected').style.display = 'block';
        document.getElementById('walletAddressDisplay').textContent = Wallet.formatAddress(address);
        
        if (currentUser && !currentUser.walletAddress) {
            try {
                await API.linkWallet(address);
                currentUser.walletAddress = address;
            } catch (e) {
                console.log('Wallet déjà lié ou erreur:', e);
            }
        }

        showToast('Wallet connecté !', 'success');

    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur de connexion au wallet', 'error');
    }
}

async function processPayment() {
    if (!selectedPack) {
        showToast('Sélectionnez un pack d\'abord', 'warning');
        return;
    }

    if (!Wallet.isConnected()) {
        showToast('Connectez votre wallet d\'abord', 'warning');
        return;
    }

    var pack = PACK_PRICES[selectedPack];
    // Convertir ETH en Wei
    var ethValue = parseFloat(pack.eth);
    var weiValue = (ethValue * 1e18).toString();

    try {
        showLoading('Transaction en cours...');
        
        var txHash = await Wallet.sendPayment(CRYPTO_ADDRESSES.eth, weiValue);
        
        showLoading('Vérification de la transaction...');
        
        var response = await API.purchaseTokens(selectedPack, txHash);
        
        hideLoading();

        if (response.success) {
            updateTokenDisplay(response.data.newBalance);
            showToast(pack.tokens + ' jetons ajoutés !', 'success');
            
            // Reset
            selectedPack = null;
            selectedCrypto = null;
            document.querySelectorAll('.shop-pack').forEach(function(el) { 
                el.classList.remove('selected'); 
            });
            document.getElementById('paymentSection').style.display = 'none';
        }

    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur de paiement', 'error');
    }
}

async function giftTokens() {
    if (!currentUser) {
        showToast('Connectez-vous d\'abord', 'warning');
        showLoginModal();
        return;
    }

    try {
        showLoading('Ajout des jetons...');
        
        var response = await API.claimGift();
        
        hideLoading();

        if (response.success) {
            updateTokenDisplay(response.data.newBalance);
            showToast('5 jetons de test ajoutés !', 'success');
        }
    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur', 'error');
    }
}

// ══════════════════════════════════════════════════════════════
// Navigation
// ══════════════════════════════════════════════════════════════

function goHome() {
    document.getElementById('heroSection').style.display = 'flex';
    document.getElementById('shopSection').style.display = 'none';
    document.getElementById('gameSection').style.display = 'none';
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('adminSection').style.display = 'none';
    
    restartSpeechBubbles();
}

// ══════════════════════════════════════════════════════════════
// Leaderboard
// ══════════════════════════════════════════════════════════════

async function showLeaderboard() {
    showModal('leaderboardModal');
    var list = document.getElementById('leaderboardList');
    list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Chargement...</p>';

    try {
        var response = await API.getLeaderboard();
        var players = response.data;

        if (!players || players.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Aucun joueur pour l\'instant. Soyez le premier !</p>';
            return;
        }

        var medals = ['🥇', '🥈', '🥉'];
        list.innerHTML = '';
        players.forEach(function(player) {
            var row = document.createElement('div');
            row.className = 'leaderboard-row' + (player.rank <= 3 ? ' top-' + player.rank : '');

            var rankEl = document.createElement('span');
            rankEl.className = 'leaderboard-rank';
            rankEl.textContent = medals[player.rank - 1] || '#' + player.rank;

            var nameEl = document.createElement('span');
            nameEl.className = 'leaderboard-name';
            nameEl.textContent = player.username;

            var gamesEl = document.createElement('span');
            gamesEl.className = 'leaderboard-games';
            gamesEl.textContent = player.totalGames + ' partie' + (player.totalGames !== 1 ? 's' : '');

            row.appendChild(rankEl);
            row.appendChild(nameEl);
            row.appendChild(gamesEl);
            list.appendChild(row);
        });
    } catch (error) {
        list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Erreur de chargement</p>';
    }
}

// ══════════════════════════════════════════════════════════════
// Historique des parties
// ══════════════════════════════════════════════════════════════

async function loadGameHistory() {
    var list = document.getElementById('gameHistoryList');
    if (!list || !currentUser) return;

    list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Chargement...</p>';

    try {
        var response = await API.getHistory();
        var games = response.data;

        if (!games || games.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Aucune partie jouée pour l\'instant.</p>';
            return;
        }

        list.innerHTML = '';
        games.forEach(function(game) {
            var card = document.createElement('div');
            card.className = 'history-card';

            var dateEl = document.createElement('div');
            dateEl.className = 'history-date';
            dateEl.textContent = game.startedAt ? new Date(game.startedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Date inconnue';

            var filtersEl = document.createElement('div');
            filtersEl.className = 'history-filters';
            if (game.filters && game.filters.length > 0) {
                game.filters.forEach(function(f) {
                    var tag = document.createElement('span');
                    tag.className = 'filter-tag';
                    tag.textContent = f.text || f.slug;
                    filtersEl.appendChild(tag);
                });
            } else {
                filtersEl.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem;">Aucun filtre</span>';
            }

            var gamesEl = document.createElement('div');
            gamesEl.className = 'history-games';
            if (game.games && game.games.length > 0) {
                var gameCount = document.createElement('span');
                gameCount.style.cssText = 'color:var(--text-muted);font-size:0.78rem;';
                gameCount.textContent = game.games.length + ' jeu' + (game.games.length > 1 ? 'x' : '') + ' recommandé' + (game.games.length > 1 ? 's' : '');
                gamesEl.appendChild(gameCount);
            }

            card.appendChild(dateEl);
            card.appendChild(filtersEl);
            card.appendChild(gamesEl);
            list.appendChild(card);
        });
    } catch (error) {
        list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Erreur de chargement</p>';
    }
}

// ══════════════════════════════════════════════════════════════
// Admin
// ══════════════════════════════════════════════════════════════

function showAdminSection() {
    document.getElementById('heroSection').style.display = 'none';
    document.getElementById('shopSection').style.display = 'none';
    document.getElementById('gameSection').style.display = 'none';
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('adminSection').style.display = 'block';
    stopSpeechBubbles();
    loadAdminData();
}

async function loadAdminData() {
    try {
        // Charger les stats
        const stats = await API.getAdminStats();
        document.getElementById('statUsers').textContent = stats.data.users.total;
        document.getElementById('statGames').textContent = stats.data.games.total;
        document.getElementById('statTokens').textContent = stats.data.tokens.total;
        
        // Charger les utilisateurs
        const users = await API.getAdminUsers();
        displayUsers(users.data.users);

        // Charger les transactions en attente
        await loadPendingTransactions();
    } catch (error) {
        console.error('Erreur chargement admin:', error);
        showToast('Erreur lors du chargement des données admin', 'error');
    }
}

function displayUsers(users) {
    const tbody = document.getElementById('usersTableBody');
    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem;">Aucun utilisateur</td></tr>';
        return;
    }
    
    // Utiliser createElement pour éviter XSS (échappement automatique)
    tbody.innerHTML = '';
    users.forEach(user => {
        const tr = document.createElement('tr');
        
        // Username (échappé)
        const tdUsername = document.createElement('td');
        const strong = document.createElement('strong');
        strong.textContent = user.username;
        tdUsername.appendChild(strong);
        tr.appendChild(tdUsername);
        
        // Tokens
        const tdTokens = document.createElement('td');
        tdTokens.textContent = user.tokens;
        tr.appendChild(tdTokens);
        
        // Total games
        const tdGames = document.createElement('td');
        tdGames.textContent = user.total_games || 0;
        tr.appendChild(tdGames);
        
        // Created at
        const tdCreated = document.createElement('td');
        tdCreated.textContent = user.created_at ? new Date(user.created_at).toLocaleDateString('fr-FR') : '-';
        tr.appendChild(tdCreated);
        
        // Last login
        const tdLogin = document.createElement('td');
        tdLogin.textContent = user.last_login ? new Date(user.last_login).toLocaleDateString('fr-FR') : 'Jamais';
        tr.appendChild(tdLogin);
        
        // Admin status
        const tdAdmin = document.createElement('td');
        if (user.is_admin) {
            const adminSpan = document.createElement('span');
            adminSpan.style.color = 'var(--primary)';
            adminSpan.textContent = '✓ Admin';
            tdAdmin.appendChild(adminSpan);
        } else {
            tdAdmin.textContent = '-';
        }
        tr.appendChild(tdAdmin);
        
        // Actions
        const tdActions = document.createElement('td');
        
        // View button
        const btnView = document.createElement('button');
        btnView.className = 'btn btn-sm btn-ghost';
        btnView.title = 'Voir détails';
        btnView.onclick = () => viewUserDetails(user.id);
        btnView.innerHTML = '<i class="fa-solid fa-eye"></i>';
        tdActions.appendChild(btnView);
        
        // Promote button (if not admin)
        if (!user.is_admin) {
            const btnPromote = document.createElement('button');
            btnPromote.className = 'btn btn-sm btn-primary';
            btnPromote.title = 'Promouvoir admin';
            btnPromote.onclick = () => promoteUser(user.id, user.username);
            btnPromote.innerHTML = '<i class="fa-solid fa-shield-halved"></i>';
            tdActions.appendChild(btnPromote);
        }
        
        // Delete button (if not current user)
        if (user.id !== currentUser.id) {
            const btnDelete = document.createElement('button');
            btnDelete.className = 'btn btn-sm btn-danger';
            btnDelete.title = 'Supprimer';
            btnDelete.onclick = () => deleteUser(user.id, user.username);
            btnDelete.innerHTML = '<i class="fa-solid fa-trash"></i>';
            tdActions.appendChild(btnDelete);
        }
        
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
    });
}

async function loadPendingTransactions() {
    const tbody = document.getElementById('pendingTransactionsBody');
    if (!tbody) return;
    try {
        const result = await API.getPendingTransactions();
        const txList = result.data;
        tbody.innerHTML = '';
        if (!txList || txList.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted);">Aucune transaction en attente</td></tr>';
            return;
        }
        txList.forEach(tx => {
            const tr = document.createElement('tr');

            const tdUser = document.createElement('td');
            tdUser.textContent = tx.username;
            tr.appendChild(tdUser);

            const tdAmount = document.createElement('td');
            tdAmount.textContent = tx.amount + ' jetons';
            tr.appendChild(tdAmount);

            const tdInvoice = document.createElement('td');
            const code = document.createElement('code');
            code.style.fontSize = '0.75rem';
            code.textContent = tx.tx_hash || '-';
            tdInvoice.appendChild(code);
            tr.appendChild(tdInvoice);

            const tdDate = document.createElement('td');
            tdDate.textContent = tx.created_at ? new Date(tx.created_at).toLocaleDateString('fr-FR') : '-';
            tr.appendChild(tdDate);

            const tdActions = document.createElement('td');
            const btnApprove = document.createElement('button');
            btnApprove.className = 'btn btn-sm btn-primary';
            btnApprove.title = 'Approuver';
            btnApprove.innerHTML = '<i class="fa-solid fa-check"></i> Approuver';
            btnApprove.onclick = () => approveTransaction(tx.id);
            tdActions.appendChild(btnApprove);

            const btnReject = document.createElement('button');
            btnReject.className = 'btn btn-sm btn-danger';
            btnReject.title = 'Rejeter';
            btnReject.innerHTML = '<i class="fa-solid fa-xmark"></i> Rejeter';
            btnReject.style.marginLeft = '4px';
            btnReject.onclick = () => rejectTransaction(tx.id);
            tdActions.appendChild(btnReject);

            tr.appendChild(tdActions);
            tbody.appendChild(tr);
        });
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">Erreur de chargement</td></tr>';
    }
}

async function approveTransaction(txId) {
    if (!confirm('Approuver cette transaction et créditer les jetons ?')) return;
    try {
        await API.approveTransaction(txId);
        showToast('Transaction approuvée !', 'success');
        loadPendingTransactions();
    } catch (error) {
        showToast(error.message || 'Erreur', 'error');
    }
}

async function rejectTransaction(txId) {
    if (!confirm('Rejeter cette transaction ?')) return;
    try {
        await API.rejectTransaction(txId);
        showToast('Transaction rejetée', 'info');
        loadPendingTransactions();
    } catch (error) {
        showToast(error.message || 'Erreur', 'error');
    }
}

window.approveTransaction = approveTransaction;
window.rejectTransaction = rejectTransaction;

async function handleCleanupIPs() {
    if (!confirm('Voulez-vous nettoyer les IPs anciennes (plus de 12 mois) ?')) {
        return;
    }
    
    try {
        const result = await API.cleanupIPs();
        showToast(result.message, 'success');
        loadAdminData();
    } catch (error) {
        console.error('Erreur nettoyage IPs:', error);
        showToast('Erreur lors du nettoyage', 'error');
    }
}

async function viewUserDetails(userId) {
    try {
        const user = await API.getAdminUser(userId);
        alert(`Détails de ${user.data.user.username}:\n\n` +
              `Jetons: ${user.data.user.tokens}\n` +
              `Parties: ${user.data.games}\n` +
              `Transactions: ${user.data.transactions.length}\n` +
              `IP: ${user.data.user.ip_address || 'Non enregistrée'}`);
    } catch (error) {
        console.error('Erreur détails utilisateur:', error);
        showToast('Erreur lors du chargement', 'error');
    }
}

async function promoteUser(userId, username) {
    if (!confirm(`Promouvoir ${username} en administrateur ?`)) {
        return;
    }
    
    try {
        await API.promoteUser(userId);
        showToast(`${username} promu administrateur`, 'success');
        loadAdminData();
    } catch (error) {
        console.error('Erreur promotion:', error);
        showToast('Erreur lors de la promotion', 'error');
    }
}

async function deleteUser(userId, username) {
    if (!confirm(`⚠️ Supprimer définitivement l'utilisateur ${username} ?\n\nToutes ses données seront supprimées.`)) {
        return;
    }
    
    try {
        await API.deleteAdminUser(userId);
        showToast(`Utilisateur ${username} supprimé`, 'success');
        loadAdminData();
    } catch (error) {
        console.error('Erreur suppression:', error);
        showToast('Erreur lors de la suppression', 'error');
    }
}

// Exposer les fonctions globalement pour les boutons onclick
window.viewUserDetails = viewUserDetails;
window.promoteUser = promoteUser;
window.deleteUser = deleteUser;

// ══════════════════════════════════════════════════════════════
// Modals
// ══════════════════════════════════════════════════════════════

function showModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
    
    var errorDiv = document.getElementById(modalId.replace('Modal', 'Error'));
    if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.style.display = 'none';
    }
}

function showLoginModal() {
    closeModal('registerModal');
    showModal('loginModal');
}

function showRegisterModal() {
    closeModal('loginModal');
    showModal('registerModal');
}

// ══════════════════════════════════════════════════════════════
// UI Helpers
// ══════════════════════════════════════════════════════════════

function showLoading(text) {
    document.getElementById('loadingText').textContent = text || 'Chargement...';
    document.getElementById('loadingOverlay').classList.add('active');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.remove('active');
}

function showToast(message, type) {
    var container = document.getElementById('toastContainer');
    
    var icons = {
        success: 'fa-circle-check',
        error: 'fa-circle-xmark',
        warning: 'fa-triangle-exclamation',
        info: 'fa-circle-info'
    };

    var toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'info');
    // Échapper le message pour éviter XSS
    const iconClass = icons[type || 'info'] || icons.info;
    const escapedMessage = escapeHtml(message);
    toast.innerHTML = '<i class="fa-solid ' + iconClass + ' toast-icon"></i><span>' + escapedMessage + '</span>';
    
    container.appendChild(toast);

    setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(function() { toast.remove(); }, 300);
    }, 4000);
}

// ══════════════════════════════════════════════════════════════
// Effets visuels
// ══════════════════════════════════════════════════════════════

function createParticles() {
    var container = document.getElementById('particles');
    if (!container) return;
    
    for (var i = 0; i < 15; i++) {
        var particle = document.createElement('div');
        particle.style.cssText = 
            'position: absolute;' +
            'width: ' + (Math.random() * 4 + 2) + 'px;' +
            'height: ' + (Math.random() * 4 + 2) + 'px;' +
            'background: rgba(145, 70, 255, ' + (Math.random() * 0.3 + 0.1) + ');' +
            'border-radius: 50%;' +
            'left: ' + (Math.random() * 100) + '%;' +
            'top: ' + (Math.random() * 100) + '%;' +
            'animation: particleFloat ' + (Math.random() * 10 + 10) + 's linear infinite;' +
            'animation-delay: ' + (Math.random() * 5) + 's;';
        container.appendChild(particle);
    }

    var style = document.createElement('style');
    style.textContent = '@keyframes particleFloat { 0% { transform: translateY(100vh) rotate(0deg); opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { transform: translateY(-100vh) rotate(720deg); opacity: 0; } }';
    document.head.appendChild(style);
}

// Exposer les fonctions pour game.js
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.showToast = showToast;
window.showLoginModal = showLoginModal;
window.showShopSection = showShopSection;
window.updateTokenDisplay = updateTokenDisplay;
window.showGameSection = function() {
    stopSpeechBubbles();

    document.getElementById('heroSection').style.display = 'none';
    document.getElementById('shopSection').style.display = 'none';
    document.getElementById('adminSection').style.display = 'none';
    document.getElementById('gameSection').style.display = 'flex';
    document.getElementById('resultsSection').style.display = 'none';
};

// ══════════════════════════════════════════════════════════════
// A2F (Authentification à 2 facteurs)
// ══════════════════════════════════════════════════════════════

// Variable obsolète supprimée - utilisation de window.pendingA2FToken à la place

async function setupA2F() {
    if (!currentUser) return;
    
    // Vérifier si déjà activé
    if (currentUser.a2fEnabled) {
        showToast('A2F déjà activé sur votre compte', 'info');
        return;
    }
    
    try {
        showLoading('Configuration de l\'A2F...');
        
        var response = await API.setupA2F();
        
        hideLoading();
        
        if (response.success) {
            // Afficher le QR code
            document.getElementById('qrCodeContainer').innerHTML = 
                '<img src="' + response.data.qrCode + '" alt="QR Code A2F">';
            
            // Afficher le secret
            document.getElementById('a2fSecretCode').textContent = response.data.secret;
            document.getElementById('a2fSecretDisplay').style.display = 'block';
            
            // Ouvrir le modal
            showModal('a2fSetupModal');
        }
    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur lors de la configuration', 'error');
    }
}

async function verifyA2FSetup() {
    var code = document.getElementById('a2fVerifyCode').value.trim();
    
    if (!code || code.length !== 6) {
        showToast('Entrez un code à 6 chiffres', 'warning');
        return;
    }
    
    try {
        showLoading('Vérification...');
        
        var response = await API.verifyA2FSetup(code);
        
        hideLoading();
        
        if (response.success) {
            currentUser.a2fEnabled = true;
            closeModal('a2fSetupModal');
            updateA2FStatus();
            showToast('A2F activé avec succès !', 'success');
        }
    } catch (error) {
        hideLoading();
        showToast(error.message || 'Code incorrect', 'error');
    }
}

async function verifyA2FLogin() {
    var code = document.getElementById('a2fLoginCode').value.trim();
    var errorDiv = document.getElementById('a2fLoginError');
    var tempToken = window.pendingA2FToken;
    
    errorDiv.style.display = 'none';
    
    if (!code || code.length !== 6) {
        errorDiv.textContent = 'Code invalide (6 chiffres)';
        errorDiv.style.display = 'block';
        return;
    }
    
    if (!tempToken) {
        errorDiv.textContent = 'Session expirée, veuillez vous reconnecter';
        errorDiv.style.display = 'block';
        return;
    }
    
    try {
        showLoading('Vérification...');
        
        var response = await API.verifyLoginA2F(code, tempToken);
        
        hideLoading();
        
        if (response.success) {
            currentUser = response.data.user;
            window.pendingA2FToken = null;
            updateUIForLoggedInUser();
            closeModal('a2fLoginModal');
            showToast('Connexion réussie !', 'success');
        }
    } catch (error) {
        hideLoading();
        errorDiv.textContent = error.message || 'Code incorrect';
        errorDiv.style.display = 'block';
    }
}

function updateA2FStatus() {
    var statusDiv = document.getElementById('a2fStatus');
    var toggleBtn = document.getElementById('toggleA2F');
    
    if (currentUser && currentUser.a2fEnabled) {
        statusDiv.innerHTML = '<span class="a2f-badge enabled">Activé</span><p>Votre compte est protégé par l\'A2F.</p>';
        toggleBtn.innerHTML = '<i class="fa-solid fa-lock-open icon"></i> Désactiver l\'A2F';
        toggleBtn.onclick = function() {
            showToast('Pour désactiver l\'A2F, contactez le support.', 'info');
        };
    } else {
        statusDiv.innerHTML = '<span class="a2f-badge disabled">Désactivé</span><p>Protégez votre compte avec une couche de sécurité supplémentaire.</p>';
        toggleBtn.innerHTML = '<i class="fa-solid fa-lock icon"></i> Activer l\'A2F';
        toggleBtn.onclick = setupA2F;
    }
    // Note: innerHTML ici est sûr car le contenu est statique (pas de données utilisateur)
}

// ══════════════════════════════════════════════════════════════
// Upload Avatar
// ══════════════════════════════════════════════════════════════

async function uploadAvatar(event) {
    var file = event.target.files[0];
    if (!file) return;
    
    // Vérification client
    var allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
        showToast('Format non autorisé. Utilisez JPEG, PNG ou WebP.', 'error');
        return;
    }
    
    if (file.size > 5 * 1024 * 1024) {
        showToast('Fichier trop volumineux (max 5 MB)', 'error');
        return;
    }
    
    try {
        showLoading('Upload en cours...');
        
        var response = await API.uploadAvatar(file);
        
        hideLoading();
        
        if (response.success) {
            currentUser.avatarUrl = response.data.avatarUrl;
            // Mettre à jour l'image
            document.getElementById('profileAvatarImg').src = response.data.avatarUrl + '?t=' + Date.now();
            showToast('Photo de profil mise à jour !', 'success');
        }
    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur lors de l\'upload', 'error');
    }
}

// ══════════════════════════════════════════════════════════════
// Pages Légales
// ══════════════════════════════════════════════════════════════

function showPrivacyPolicy() {
    var content = document.getElementById('privacyContent');
    content.innerHTML = `
        <p><strong>Dernière mise à jour :</strong> 28 janvier 2026</p>
        
        <h3>1. Introduction</h3>
        <p>AkinatorTwitch ("nous", "notre", "nos") s'engage à protéger votre vie privée. Cette politique explique comment nous collectons, utilisons et protégeons vos données personnelles.</p>
        
        <h3>2. Données collectées</h3>
        <p>Nous collectons les données suivantes :</p>
        <ul>
            <li><strong>Données d'inscription :</strong> nom d'utilisateur, adresse email (optionnelle)</li>
            <li><strong>Données de sécurité :</strong> mot de passe (hashé), secret A2F (chiffré)</li>
            <li><strong>Données d'utilisation :</strong> historique des parties, transactions de jetons</li>
            <li><strong>Données techniques :</strong> adresse IP, user-agent (pour la sécurité)</li>
            <li><strong>Données de paiement :</strong> adresse de wallet crypto, hash de transactions</li>
        </ul>
        
        <h3>3. Utilisation des données</h3>
        <p>Vos données sont utilisées pour :</p>
        <ul>
            <li>Fournir et améliorer nos services</li>
            <li>Gérer votre compte et vos jetons</li>
            <li>Assurer la sécurité de la plateforme</li>
            <li>Prévenir la fraude et les abus</li>
            <li>Respecter nos obligations légales</li>
        </ul>
        
        <h3>4. Sécurité des données</h3>
        <p>Nous appliquons les mesures de sécurité suivantes :</p>
        <ul>
            <li>Mots de passe hashés avec bcrypt (12 rounds)</li>
            <li>Chiffrement des données sensibles</li>
            <li>Protection contre les injections SQL</li>
            <li>Limitation des tentatives de connexion</li>
            <li>Authentification à deux facteurs (A2F) disponible</li>
        </ul>
        
        <h3>5. Conservation des données</h3>
        <ul>
            <li><strong>Données de compte :</strong> conservées tant que le compte est actif</li>
            <li><strong>Historique des transactions :</strong> 5 ans (obligation légale)</li>
            <li><strong>Logs de sécurité :</strong> 1 an</li>
            <li><strong>Données supprimées :</strong> effacement sécurisé sous 30 jours</li>
        </ul>
        
        <h3>6. Vos droits (RGPD)</h3>
        <p>Vous disposez des droits suivants :</p>
        <ul>
            <li><strong>Droit d'accès :</strong> obtenir une copie de vos données</li>
            <li><strong>Droit de rectification :</strong> corriger vos données</li>
            <li><strong>Droit à l'effacement :</strong> supprimer votre compte</li>
            <li><strong>Droit à la portabilité :</strong> exporter vos données</li>
            <li><strong>Droit d'opposition :</strong> vous opposer au traitement</li>
        </ul>
        
        <h3>7. Cookies</h3>
        <p>Nous utilisons uniquement des cookies techniques essentiels (token JWT) pour maintenir votre session. Aucun cookie de tracking ou publicitaire n'est utilisé.</p>
        
        <h3>8. Contact</h3>
        <p>Pour toute question concernant vos données : <strong>privacy@akinatortwitch.com</strong></p>
    `;
    showModal('privacyModal');
}

function showDataProcessing() {
    var content = document.getElementById('dataContent');
    content.innerHTML = `
        <p><strong>Dernière mise à jour :</strong> 28 janvier 2026</p>
        
        <h3>1. Responsable du traitement</h3>
        <p>AkinatorTwitch est responsable du traitement de vos données personnelles conformément au Règlement Général sur la Protection des Données (RGPD).</p>
        
        <h3>2. Base légale du traitement</h3>
        <table style="width:100%; border-collapse: collapse; margin: 15px 0;">
            <tr style="border-bottom: 1px solid var(--border);">
                <th style="text-align:left; padding: 8px;">Traitement</th>
                <th style="text-align:left; padding: 8px;">Base légale</th>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">Création de compte</td>
                <td style="padding: 8px;">Exécution du contrat</td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">Gestion des jetons</td>
                <td style="padding: 8px;">Exécution du contrat</td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">Sécurité du compte</td>
                <td style="padding: 8px;">Intérêt légitime</td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">Logs de connexion</td>
                <td style="padding: 8px;">Obligation légale</td>
            </tr>
            <tr>
                <td style="padding: 8px;">Transactions crypto</td>
                <td style="padding: 8px;">Obligation légale (LCB-FT)</td>
            </tr>
        </table>
        
        <h3>3. Destinataires des données</h3>
        <p>Vos données ne sont <strong>jamais vendues</strong> à des tiers. Elles peuvent être partagées avec :</p>
        <ul>
            <li>Nos prestataires techniques (hébergement sécurisé)</li>
            <li>Les autorités compétentes sur demande légale</li>
        </ul>
        
        <h3>4. Transferts internationaux</h3>
        <p>Vos données sont hébergées en France/UE. Aucun transfert hors UE n'est effectué.</p>
        
        <h3>5. Durée de conservation</h3>
        <table style="width:100%; border-collapse: collapse; margin: 15px 0;">
            <tr style="border-bottom: 1px solid var(--border);">
                <th style="text-align:left; padding: 8px;">Données</th>
                <th style="text-align:left; padding: 8px;">Durée</th>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">Compte utilisateur</td>
                <td style="padding: 8px;">Durée du compte + 3 ans</td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">Transactions</td>
                <td style="padding: 8px;">5 ans (obligation comptable)</td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">Logs de sécurité</td>
                <td style="padding: 8px;">1 an</td>
            </tr>
            <tr>
                <td style="padding: 8px;">Données après suppression</td>
                <td style="padding: 8px;">Effacement sous 30 jours</td>
            </tr>
        </table>
        
        <h3>6. Sécurité technique</h3>
        <h4>Mesures implémentées :</h4>
        <ul class="check-list">
            <li>Hashage bcrypt (12 rounds) pour les mots de passe</li>
            <li>Chiffrement AES-256 pour les secrets A2F</li>
            <li>Prepared statements (anti-injection SQL)</li>
            <li>Rate limiting (anti brute-force)</li>
            <li>Verrouillage après 5 tentatives échouées</li>
            <li>HTTPS obligatoire</li>
            <li>Headers de sécurité (CSP, HSTS, etc.)</li>
            <li>Validation stricte des uploads (anti-RCE)</li>
        </ul>
        
        <h3>7. Exercer vos droits</h3>
        <p>Pour exercer vos droits RGPD (accès, rectification, effacement, portabilité, opposition) :</p>
        <ul>
            <li>Email : <strong>dpo@akinatortwitch.com</strong></li>
            <li>Délai de réponse : 30 jours maximum</li>
        </ul>
        
        <h3>8. Réclamation</h3>
        <p>En cas de litige, vous pouvez saisir la CNIL (Commission Nationale de l'Informatique et des Libertés) : <a href="https://www.cnil.fr" target="_blank" style="color: var(--primary);">www.cnil.fr</a></p>
    `;
    showModal('dataModal');
}

// ══════════════════════════════════════════════════════════════
// Bulles de dialogue animées
// ══════════════════════════════════════════════════════════════

// Messages pour les bulles de dialogue
const SPEECH_MESSAGES = [
    // Messages d'accueil
    { left: 'Commencez votre recherche', right: 'Trouvez votre jeu idéal' },
    { left: 'Répondez aux questions', right: 'Je trouve votre jeu !' },
    { left: 'Quel genre préférez-vous ?', right: 'Action, RPG, Aventure...' },
    
    // Messages de recherche
    { left: 'Sur quelle plateforme ?', right: 'PC, PlayStation, Xbox...' },
    { left: 'Quel mode de jeu ?', right: 'Solo ou multijoueur ?' },
    { left: 'Ton jeu est : Minecraft', right: 'Ou peut-être The Witcher ?' },
    
    // Messages encourageants
    { left: 'Presque trouvé !', right: 'Encore quelques questions...' },
    { left: 'Excellent choix !', right: 'Je cherche pour vous...' },
    { left: 'Découvrez de nouveaux jeux', right: 'Adaptés à vos goûts !' }
];

let currentMessageIndex = 0;
let speechBubbleInterval = null;

/**
 * Initialise les bulles de dialogue animées
 */
function initSpeechBubbles() {
    const bubble1 = document.getElementById('speechBubble1');
    const bubble2 = document.getElementById('speechBubble2');
    
    if (!bubble1 || !bubble2) return;
    
    // Afficher les premières bulles
    setTimeout(() => {
        bubble1.classList.add('show');
        bubble2.classList.add('show');
    }, 500);
    
    // Changer les messages toutes les 4 secondes
    speechBubbleInterval = setInterval(() => {
        changeSpeechBubbles();
    }, 4000);
}

/**
 * Change les messages des bulles avec animation
 */
function changeSpeechBubbles() {
    const bubble1 = document.getElementById('speechBubble1');
    const bubble2 = document.getElementById('speechBubble2');
    
    if (!bubble1 || !bubble2) return;
    
    // Masquer les bulles
    bubble1.classList.remove('show');
    bubble2.classList.remove('show');
    bubble1.classList.add('hide');
    bubble2.classList.add('hide');
    
    // Changer le message après l'animation de disparition
    setTimeout(() => {
        currentMessageIndex = (currentMessageIndex + 1) % SPEECH_MESSAGES.length;
        const messages = SPEECH_MESSAGES[currentMessageIndex];
        
        bubble1.querySelector('.bubble-content').textContent = messages.left;
        bubble2.querySelector('.bubble-content').textContent = messages.right;
        
        // Réinitialiser les classes et réafficher
        bubble1.classList.remove('hide');
        bubble2.classList.remove('hide');
        
        setTimeout(() => {
            bubble1.classList.add('show');
            bubble2.classList.add('show');
        }, 100);
    }, 400);
}

/**
 * Arrête les bulles de dialogue (quand on quitte la page d'accueil)
 */
function stopSpeechBubbles() {
    if (speechBubbleInterval) {
        clearInterval(speechBubbleInterval);
        speechBubbleInterval = null;
    }
    
    const bubble1 = document.getElementById('speechBubble1');
    const bubble2 = document.getElementById('speechBubble2');
    
    if (bubble1) bubble1.classList.remove('show', 'hide');
    if (bubble2) bubble2.classList.remove('show', 'hide');
}

/**
 * Redémarre les bulles (quand on revient à l'accueil)
 */
function restartSpeechBubbles() {
    stopSpeechBubbles();
    setTimeout(() => {
        initSpeechBubbles();
    }, 500);
}

console.log('📱 App.js chargé');
