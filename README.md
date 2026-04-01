Akinator Twitch Web

Application web qui recommande des jeux vidéo via un système de questions (type Akinator), avec gestion de jetons et paiement en crypto.

Fonctionnalités
Système de questions/réponses basé sur un arbre de décision pour proposer des jeux
Intégration avec l’API IGDB (via Twitch) pour récupérer les données des jeux
Système de jetons : 1 jeton = 1 partie
Achat de jetons en crypto (MATIC sur Polygon)
Authentification sécurisée (JWT)
Interface responsive avec animations
Architecture du projet
AkinatorWeb/
├── backend/                 
│   ├── server.js           
│   ├── config/             
│   ├── routes/             
│   ├── middleware/         
│   └── services/           
│
├── frontend/               
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js         
│       ├── wallet.js      
│       ├── game.js        
│       └── app.js         
│
└── README.md
backend : API Node.js / Express
frontend : interface utilisateur (HTML, CSS, JS vanilla)
Installation
1. Prérequis
Node.js 18+
Un compte Twitch Developer : https://dev.twitch.tv/console
2. Configuration
cd backend
copy env.example.txt .env

Ensuite, modifier le fichier .env avec vos infos :

JWT_SECRET=cle_secrete (64 caractères minimum)
TWITCH_CLIENT_ID=client_id_twitch
TWITCH_CLIENT_SECRET=client_secret_twitch
3. Installer les dépendances
cd backend
npm install
4. Lancer le projet
npm start

Puis ouvrir : http://localhost:3000

Sécurité

Plusieurs mécanismes sont en place :

JWT pour l’authentification
Bcrypt pour le hash des mots de passe (12 rounds)
Helmet pour sécuriser les headers HTTP
Rate limiting pour éviter les abus
Validation et nettoyage des entrées utilisateur
Logs sans données sensibles
API
Auth
POST /api/auth/register : inscription
POST /api/auth/login : connexion
GET /api/auth/me : profil utilisateur
Game
GET /api/game/tree : récupérer l’arbre de décision
POST /api/game/start : démarrer une partie
POST /api/game/choose : répondre à une question
POST /api/game/recommend : obtenir une recommandation
Tokens
GET /api/tokens/balance : voir son solde
GET /api/tokens/prices : liste des packs
POST /api/tokens/purchase : acheter des jetons
POST /api/tokens/gift : récupérer des jetons gratuits (démo)
Paiement crypto

Le paiement se fait en MATIC sur le réseau Polygon.

Étapes :

Connecter MetaMask
Choisir un pack de jetons
Confirmer la transaction
Les jetons sont crédités automatiquement
Interface

L’application propose :

Une page d’accueil animée
Un système de questions interactif
Un affichage des jeux recommandés (avec images)
Une gestion du compte et des jetons
Auteurs

Projet réalisé par l’équipe AkinatorTwitch dans le cadre d’un master cybersécurité.

Licence

Projet pédagogique. Tous droits réservés.
