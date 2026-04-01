# 🎮 Akinator Twitch Web

Application web de recommandation de jeux vidéo avec système de jetons et paiement crypto.

## ✨ Fonctionnalités

- 🎯 **Système Akinator** - Arbre de décision pour recommander des jeux
- 🔍 **Intégration IGDB** - Base de données de jeux Twitch/IGDB
- 🪙 **Système de Jetons** - 1 jeton = 1 partie
- 💰 **Paiement Crypto** - Achat de jetons en MATIC (Polygon)
- 🔐 **Sécurité** - JWT, rate limiting, validation, chiffrement
- 🎨 **Interface Moderne** - Design responsive avec animations

## 🏗️ Architecture

```
AkinatorWeb/
├── backend/                 # API Node.js + Express
│   ├── server.js           # Point d'entrée
│   ├── config/             # Configuration
│   ├── routes/             # Routes API
│   ├── middleware/         # Sécurité
│   └── services/           # IGDB, Database
│
├── frontend/               # Interface utilisateur
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js         # Client API
│       ├── wallet.js      # Web3 / MetaMask
│       ├── game.js        # Logique du jeu
│       └── app.js         # Application principale
│
└── README.md
```

## 🚀 Installation

### 1. Prérequis

- **Node.js 18+** : https://nodejs.org
- **Compte Twitch Developer** : https://dev.twitch.tv/console

### 2. Configuration

```bash
cd backend

# Copier le fichier de configuration
copy env.example.txt .env

# Éditer .env avec vos credentials
notepad .env
```

**Variables à configurer dans `.env` :**

```env
JWT_SECRET=votre_cle_secrete_64_caracteres_minimum
TWITCH_CLIENT_ID=votre_client_id_twitch
TWITCH_CLIENT_SECRET=votre_client_secret_twitch
```

### 3. Installation des dépendances

```bash
cd backend
npm install
```

### 4. Lancement

```bash
npm start
```

Ouvrez http://localhost:3000 dans votre navigateur.

## 🔐 Sécurité Implémentée

| Mesure | Description |
|--------|-------------|
| **JWT** | Authentification sécurisée avec tokens |
| **Bcrypt** | Hash des mots de passe (12 rounds) |
| **Helmet** | Headers de sécurité HTTP |
| **Rate Limiting** | Protection contre les abus |
| **CORS** | Contrôle des origines |
| **Validation** | Sanitization de toutes les entrées |
| **Logging** | Sans données sensibles |

## 📡 API Endpoints

### Auth
- `POST /api/auth/register` - Inscription
- `POST /api/auth/login` - Connexion
- `GET /api/auth/me` - Profil utilisateur

### Game
- `GET /api/game/tree` - Arbre de décision
- `POST /api/game/start` - Démarrer une partie
- `POST /api/game/choose` - Sélectionner une option
- `POST /api/game/recommend` - Obtenir les recommandations

### Tokens
- `GET /api/tokens/balance` - Solde de jetons
- `GET /api/tokens/prices` - Prix des packs
- `POST /api/tokens/purchase` - Acheter des jetons
- `POST /api/tokens/gift` - Jetons gratuits (démo)

## 💳 Paiement Crypto

L'application supporte les paiements en **MATIC** sur le réseau **Polygon**.

1. Connectez MetaMask
2. Sélectionnez un pack de jetons
3. Confirmez la transaction
4. Les jetons sont crédités automatiquement

## 🎨 Screenshots

L'interface moderne inclut :
- Page d'accueil avec animations
- Système de questions interactif
- Affichage des jeux recommandés avec images
- Gestion du compte et des jetons

## 👨‍💻 Auteurs

**AkinatorTwitch Team** - Master Cybersécurité

## 📄 Licence

Projet pédagogique - Tous droits réservés
