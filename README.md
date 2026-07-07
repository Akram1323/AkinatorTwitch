# 🎮 Akinator Twitch Web

> Application web de recommandation de jeux vidéo façon « Akinator », avec système de jetons et paiement crypto.
> Projet pédagogique développé dans le cadre d'un **Master Cybersécurité**, avec un fort accent sur la sécurité applicative.

![Node](https://img.shields.io/badge/Node.js-20.11-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## 📖 Sommaire

- [Aperçu](#-aperçu)
- [Fonctionnalités](#-fonctionnalités)
- [Stack technique](#-stack-technique)
- [Architecture](#-architecture)
- [Installation](#-installation)
- [Configuration (`.env`)](#-configuration-env)
- [Sécurité](#-sécurité)
- [API](#-api)
- [Paiement crypto](#-paiement-crypto)
- [Déploiement](#-déploiement)
- [Licence](#-licence)

---

## 🔎 Aperçu

L'utilisateur répond à une série de questions (arbre de décision). L'application en déduit un
type de jeu et propose des recommandations enrichies via la base de données **IGDB** (Twitch).
Chaque partie consomme **1 jeton** ; les jetons s'obtiennent gratuitement (claim quotidien / cadeau
de démo) ou par **achat en crypto**.

## ✨ Fonctionnalités

### Jeu & recommandations
- 🎯 **Moteur Akinator** — arbre de décision navigable (nœuds, enfants, choix)
- 🔍 **Intégration IGDB** — jeux, jaquettes et métadonnées via l'API Twitch/IGDB
- 🏆 **Leaderboard** et **historique** des parties
- 🔥 **Jeux populaires** en vitrine

### Comptes & jetons
- 🔐 **Authentification JWT** (inscription, connexion, déconnexion)
- 🪙 **Système de jetons** — 1 jeton = 1 partie
- 🎁 **Claim quotidien** de jetons gratuits
- 🖼️ **Avatars** — upload, redimensionnement et conversion WebP (Sharp)
- 🔑 **Mot de passe** — changement et réinitialisation
- 🛡️ **2FA / A2F (TOTP)** — activation via QR code (compatible Google Authenticator, etc.)

### Paiement
- 💰 **Achat de jetons en crypto** (BTC / ETH) par packs
- 🧾 **BTCPay Server** — génération d'invoices et validation par webhook signé (HMAC)
- 👛 **Liaison de wallet** (Web3 / MetaMask)

### Administration
- 🛠️ **Panneau admin** — statistiques, gestion des utilisateurs (promotion/rétrogradation,
  crédit de jetons, déblocage de comptes) et **validation manuelle des transactions**

## 🧰 Stack technique

| Domaine | Technologies |
|---------|--------------|
| **Runtime** | Node.js 20.11 |
| **Backend** | Express 4 |
| **Base de données** | SQLite (`better-sqlite3`) |
| **Auth & sécurité** | `jsonwebtoken`, `bcrypt`, `helmet`, `express-rate-limit`, `express-validator`, CSRF maison, chiffrement AES maison |
| **2FA** | `speakeasy` (TOTP) + `qrcode` |
| **Média** | `multer`, `sharp` |
| **Crypto / paiement** | BTCPay Server (`axios`), `ethers` (Web3) |
| **Frontend** | HTML / CSS / JavaScript vanilla (pas de framework) |

## 🏗️ Architecture

```
AkinatorWeb/
├── backend/                    # API Node.js + Express
│   ├── server.js               # Point d'entrée
│   ├── config/config.js        # Configuration centralisée (env)
│   ├── routes/                 # auth, game, tokens, a2f, avatar, admin
│   ├── middleware/             # security.js (JWT, rate limit…), csrf.js
│   ├── services/               # igdb, btcpay, database, encryption, cleanup
│   ├── migrations/             # évolutions du schéma SQLite
│   ├── scripts/                # outils d'admin / diagnostic
│   └── data/akinator.db        # base SQLite (générée)
│
├── frontend/                   # Interface utilisateur (statique)
│   ├── index.html
│   ├── css/style.css
│   └── js/                     # api.js, wallet.js, game.js, app.js
│
├── render.yaml                 # Déploiement Render
└── .node-version               # 20.11.0
```

## 🚀 Installation

### 1. Prérequis
- **Node.js 20.11+** — https://nodejs.org
- Un **compte Twitch Developer** (optionnel, pour IGDB) — https://dev.twitch.tv/console

### 2. Récupérer le projet et configurer l'environnement
```bash
cd AkinatorWeb/backend

# Créer le fichier de configuration à partir de l'exemple
cp env.example.txt .env

# Éditer .env avec vos identifiants (voir section Configuration)
nano .env
```

### 3. Installer les dépendances
```bash
npm install
```

### 4. Lancer
```bash
npm start        # production
npm run dev      # développement (rechargement auto via node --watch)
```

Ouvrez ensuite **http://localhost:3000** dans votre navigateur.

> 💡 La base SQLite est créée automatiquement au démarrage.
> Scripts utiles : `npm run init-db`, ainsi que les outils dans `backend/scripts/`
> (ex. `node scripts/create-admin.js` pour créer un compte administrateur).

## ⚙️ Configuration (`.env`)

| Variable | Requis | Description |
|----------|:------:|-------------|
| `JWT_SECRET` | ✅ | Clé secrète JWT (≥ 64 caractères aléatoires) |
| `ENCRYPTION_KEY` | ✅ (prod) | Clé AES-256 (64 caractères hex) pour le chiffrement des IPs. **Obligatoire en production** : le serveur refuse de démarrer si absente (fail-secure). En dev/test uniquement, une clé de repli dérivée de `JWT_SECRET` est utilisée. Génération : `node scripts/generate-keys.js` |
| `AUDIT_HMAC_KEY` | ✅ (prod) | Clé HMAC dédiée à l'intégrité du journal d'audit. Même règle fail-secure qu'`ENCRYPTION_KEY` (obligatoire en production, repli dev/test uniquement) |
| `IP_HASH_SALT` | — | Sel utilisé pour le hachage des adresses IP |
| `PORT` | — | Port du serveur (défaut : `3000`) |
| `NODE_ENV` | — | `development` ou `production` |
| `DATABASE_PATH` | — | Chemin de la base SQLite (défaut : `./data/akinator.db`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | ✅ (création admin) | Identifiants du compte admin créé au démarrage ; sans `ADMIN_PASSWORD`, la création est ignorée |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | — | Accès à l'API IGDB (recommandations enrichies) |
| `BTCPAY_SERVER_URL` / `BTCPAY_API_KEY` / `BTCPAY_STORE_ID` / `BTCPAY_WEBHOOK_SECRET` | — | Paiement crypto réel via BTCPay |
| `APP_URL` | — | URL publique de l'app (redirection après paiement) |
| `CORS_ORIGIN` | — | Origine(s) autorisée(s) pour CORS |

> ⚠️ **Ne jamais committer le fichier `.env`** — il est déjà ignoré par Git.

## 🔐 Sécurité

La sécurité est au cœur du projet. Mesures implémentées :

| Mesure | Détail |
|--------|--------|
| **JWT** | Authentification par token signé (HS256, expiration 24 h) |
| **Bcrypt** | Hash des mots de passe (12 rounds) |
| **2FA (TOTP)** | Second facteur optionnel via `speakeasy` |
| **Helmet** | En-têtes HTTP de sécurité |
| **Rate limiting** | Limitation globale + limiteur dédié aux paiements |
| **Verrouillage de compte** | Blocage temporaire après échecs de connexion répétés |
| **CSRF** | Protection maison sur les routes sensibles (`tokens`, `a2f`, `avatar`, `admin`) |
| **Validation** | Sanitization systématique des entrées (`express-validator`) |
| **Chiffrement** | Adresses IP chiffrées en base (AES-256-GCM) via `ENCRYPTION_KEY` dédiée, obligatoire en production (fail-secure) + migration dédiée |
| **Audit** | Journal d'audit protégé par chaînage HMAC (`AUDIT_HMAC_KEY`), obligatoire en production (fail-secure) |
| **Webhooks signés** | Vérification HMAC-SHA256 et comparaison *timing-safe* pour BTCPay |
| **CORS** | Origines contrôlées (fermé par défaut en production) |
| **Logs** | Journalisation sans données sensibles |

> Voir aussi [`ameliorations-secu.md`](./ameliorations-secu.md) pour les pistes d'amélioration.

## 📡 API

Base : `/api`. 🔒 = authentification requise (JWT), 👑 = réservé aux administrateurs.

### Auth — `/api/auth`
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/register` | Inscription |
| POST | `/login` | Connexion |
| POST | `/verify-login-a2f` | Vérification du second facteur à la connexion |
| GET | `/me` 🔒 | Profil utilisateur |
| POST | `/claim-daily` 🔒 | Récupérer les jetons quotidiens |
| POST | `/change-password` 🔒 | Changer le mot de passe |
| POST | `/forgot-password` | Réinitialisation du mot de passe |
| POST | `/link-wallet` 🔒 | Lier un wallet crypto |
| POST | `/logout` 🔒 | Déconnexion |

### Jeu — `/api/game`
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/tree` | Arbre de décision complet |
| GET | `/node/:id/children` | Enfants d'un nœud |
| POST | `/start` 🔒 | Démarrer une partie (consomme 1 jeton) |
| POST | `/choose` | Sélectionner une option |
| POST | `/recommend` | Obtenir les recommandations |
| GET | `/history` 🔒 | Historique des parties |
| GET | `/leaderboard` | Classement |
| GET | `/popular` | Jeux populaires |
| GET | `/igdb-status` | État de l'intégration IGDB |

### Jetons — `/api/tokens`
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/balance` 🔒 | Solde de jetons |
| GET | `/prices` | Prix des packs (BTC/ETH) |
| POST | `/purchase` 🔒 | Initier un achat |
| POST | `/verify` 🔒 | Vérifier un paiement |
| GET | `/transactions` 🔒 | Historique des transactions |
| POST | `/gift` | Jetons gratuits (démo) |
| POST | `/btcpay/create` | Créer une invoice BTCPay |
| GET | `/btcpay/status/:invoiceId` | Statut d'une invoice |

### 2FA — `/api/a2f` 🔒
`POST /setup` · `POST /verify-setup` · `POST /verify` · `POST /disable` · `GET /status`

### Avatar — `/api/avatar` 🔒
`POST /upload` · `DELETE /`

### Administration — `/api/admin` 👑
Statistiques, gestion des utilisateurs (`GET/DELETE /users`, `promote`, `demote`, `unlock`,
crédit de jetons) et validation des transactions en attente (`approve` / `reject`).

## 💳 Paiement crypto

Les jetons s'achètent par **packs** (10, 25, 50 ou 100 jetons) réglés en **BTC** ou **ETH**.

**Mode BTCPay Server (recommandé)** — auto-hébergé, sans intermédiaire :
1. Le backend crée une **invoice** via l'API BTCPay.
2. L'utilisateur paie à l'adresse fournie.
3. BTCPay notifie l'app par **webhook signé (HMAC-SHA256)**.
4. Les jetons sont crédités automatiquement après validation.

Un mode manuel (envoi crypto + hash de transaction) reste possible, avec **validation par un
administrateur** depuis le panneau d'admin.

## ☁️ Déploiement

Le projet est prêt pour **[Render](https://render.com)** via [`render.yaml`](./AkinatorWeb/render.yaml) :

- **Build** : `cd backend && npm install`
- **Start** : `cd backend && node server.js`
- **Région** : Frankfurt · **Plan** : free
- `JWT_SECRET` est généré automatiquement ; renseignez `ADMIN_PASSWORD` et, si besoin, les
  variables Twitch/BTCPay dans le tableau de bord Render.

## 🧑‍💻 Développement — hooks git

Après clonage : `git config core.hooksPath .githooks` puis installer
[gitleaks](https://github.com/gitleaks/gitleaks#installing) pour le
scan de secrets en pre-commit (la CI le rejoue systématiquement).

## 📄 Licence

Distribué sous licence **MIT** (voir `AkinatorWeb/backend/package.json`).
Projet à but **pédagogique** — *AkinatorTwitch Team, Master Cybersécurité*.
