# 🎮 Akinator Twitch Web

> Application web de recommandation de jeux vidéo façon « Akinator », avec système de jetons.
> Projet pédagogique développé dans le cadre d'un **Master Cybersécurité**, avec un fort accent sur la sécurité applicative.

![Node](https://img.shields.io/badge/Node.js-20.11-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-node:test-6DA55F)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## 📖 Sommaire

- [Aperçu](#-aperçu)
- [Fonctionnalités](#-fonctionnalités)
- [Stack technique](#-stack-technique)
- [Architecture](#-architecture)
- [Installation](#-installation)
- [Configuration (`.env`)](#-configuration-env)
- [Tests](#-tests)
- [Sécurité](#-sécurité)
- [API](#-api)
- [Jetons](#-jetons)
- [Déploiement](#-déploiement)
- [Licence](#-licence)

---

## 🔎 Aperçu

L'utilisateur répond à une série de questions (arbre de décision). L'application en déduit un
type de jeu et propose des recommandations enrichies via la base de données **IGDB** (Twitch).
Chaque partie consomme **1 jeton**.

> ⚠️ **Aucun paiement n'est branché** : le site est une démonstration. La boutique affiche des
> packs à titre de vitrine, mais les jetons s'obtiennent uniquement par le **claim quotidien**,
> par **demande adressée aux administrateurs** ou par **attribution directe d'un administrateur**.

## ✨ Fonctionnalités

### Jeu & recommandations
- 🎯 **Moteur Akinator** — arbre de décision navigable (genre → plateforme → thème → mode)
- 🔍 **Intégration IGDB** — jeux, jaquettes et métadonnées via l'API Twitch/IGDB, avec
  résolution dynamique des slugs, cache en base et contrôle de cohérence de l'arbre au démarrage
- 🏆 **Leaderboard** et **historique** des parties
- 🔥 **Jeux populaires** en vitrine

### Comptes & jetons
- 🔐 **Authentification JWT** (inscription, connexion, déconnexion) via cookies `httpOnly`
- 🪙 **Système de jetons** — 1 jeton = 1 partie
- 🎁 **Claim quotidien** de 3 jetons gratuits
- 🛒 **Boutique** — vitrine de packs (paiement indisponible) qui ouvre sur le formulaire de
  **demande de jetons à un administrateur** (montant, motif, suivi de l'état des demandes)
- 🖼️ **Avatars** — upload, redimensionnement et conversion WebP (Sharp)
- 🔑 **Mot de passe** — changement et réinitialisation, avec contrôle de robustesse
  (`zxcvbn` ≥ 3) et vérification des fuites connues (HaveIBeenPwned, k-anonymity)
- 🛡️ **2FA / A2F (TOTP)** — activation via QR code (compatible Google Authenticator, etc.),
  **codes de secours** consultables et régénérables, désactivation protégée

### Administration
- 🛠️ **Panneau admin** — statistiques, gestion des utilisateurs (promotion/rétrogradation,
  déverrouillage, suppression) et **attribution de jetons** (ajout ou fixation d'un solde, avec
  raison obligatoire, tracée en transaction et au journal d'audit)
- 📨 **File des demandes de jetons** — demandes en attente, **approbation** (crédite le
  demandeur) ou **refus**, en une transaction atomique et résistante au double traitement
- 📜 **Table « Attributions de crédits »** — journal des crédits accordés (date, admin,
  bénéficiaire, opération, solde avant/après, raison), alimentée par
  `GET /api/admin/audit?event_type=admin.user.tokens,admin.token_request.approve`
- 🔗 **Vérification d'intégrité** du journal d'audit (chaînage HMAC) et purge RGPD des IPs

## 🧰 Stack technique

| Domaine | Technologies |
|---------|--------------|
| **Runtime** | Node.js 20.11 |
| **Backend** | Express 4, `cookie-parser`, `uuid`, `axios` |
| **Base de données** | SQLite (`better-sqlite3`) |
| **Auth & sécurité** | `jsonwebtoken`, `bcrypt`, `zxcvbn`, `helmet`, `express-rate-limit`, `express-validator`, CSRF maison, chiffrement AES maison |
| **2FA** | `speakeasy` (TOTP) + `qrcode` |
| **Média** | `multer`, `sharp` |
| **Rate limiting distribué** *(optionnel)* | `ioredis` + `rate-limit-redis` (activé par `REDIS_URL`) |
| **Tests** | `node:test` (natif) + `supertest` |
| **Frontend** | HTML / CSS / JavaScript vanilla (pas de framework) |

## 🏗️ Architecture

```
AkinatorWeb/
├── backend/                    # API Node.js + Express
│   ├── server.js               # Point d'entrée (init DB, arbre, compte admin)
│   ├── config/config.js        # Configuration centralisée (env, chemins de données)
│   ├── routes/                 # auth, game, tokens, a2f, avatar, admin
│   ├── middleware/             # security.js (JWT, rate limit, CSP…), csrf.js
│   ├── services/               # database, igdb, igdbFilters, encryption, auditService,
│   │                           #   dailyTokens, tokenService, twoFactor, passwordService,
│   │                           #   cleanup, sqliteDate
│   ├── migrations/             # évolutions ponctuelles du schéma (lancées à la main)
│   ├── scripts/                # outils d'admin / diagnostic
│   └── tests/                  # suite de tests (node:test + supertest)
│
├── frontend/                   # Interface utilisateur (statique)
│   ├── index.html
│   ├── css/style.css
│   └── js/                     # api.js, game.js, app.js
│
├── render.yaml                 # Déploiement Render (plan free, stockage éphémère)
└── .node-version               # 20.11.0
```

Les **données** vivent **hors du dépôt**, dans le répertoire pointé par `DATA_DIR`
(`backend/data/` par défaut) :

```
$DATA_DIR/
├── akinator.db                 # base SQLite (créée au démarrage)
└── avatars/                    # avatars uploadés, servis sur /avatars
```

> ⚠️ Ce répertoire n'est persistant que si l'hébergement fournit un disque monté. Sur le plan
> Render `free` actuellement utilisé, il est **éphémère** — voir [Déploiement](#-déploiement).

> 📚 **Documentation technique détaillée** dans [`docs/`](./docs/) :
> [architecture](./docs/architecture.md) (carte du code, pipeline, schéma),
> [authentification](./docs/authentification.md) (tokens & sessions),
> [sécurité](./docs/securite.md) (défense en profondeur).

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
npm test         # suite de tests
```

Ouvrez ensuite **http://localhost:3000** dans votre navigateur.

> 💡 La base SQLite, l'arbre de décision et le compte admin (si `ADMIN_PASSWORD` est défini)
> sont créés au démarrage du serveur : aucune commande d'initialisation n'est nécessaire.
> Outils d'administration dans `backend/scripts/` : `create-admin.js`, `generate-keys.js`,
> `unlock-user.js`, `rotate-encryption-key.js`, `clear-all-users.js`.
> Les scripts de `backend/migrations/` sont des évolutions de schéma ponctuelles, à lancer
> manuellement (le schéma courant est créé/complété automatiquement par `services/database.js`).

## ⚙️ Configuration (`.env`)

| Variable | Requis | Description |
|----------|:------:|-------------|
| `JWT_SECRET` | ✅ | Clé secrète JWT (≥ 64 caractères aléatoires) |
| `ENCRYPTION_KEY` | ✅ (prod) | Clé AES-256 (64 caractères hex) pour le chiffrement des IPs. **Obligatoire en production** : le serveur refuse de démarrer si absente (fail-secure). En dev/test uniquement, une clé de repli dérivée de `JWT_SECRET` est utilisée. Génération : `node scripts/generate-keys.js` |
| `AUDIT_HMAC_KEY` | ✅ (prod) | Clé HMAC dédiée à l'intégrité du journal d'audit. Même règle fail-secure qu'`ENCRYPTION_KEY` (obligatoire en production, repli dev/test uniquement) |
| `IP_HASH_SALT` | — | Sel utilisé pour le hachage des adresses IP |
| `PORT` | — | Port du serveur (défaut : `3000`) |
| `NODE_ENV` | — | `development`, `production` ou `test` |
| `DATA_DIR` | — | Répertoire des données : contient `akinator.db` et `avatars/`. Défaut : `backend/data` (créé automatiquement). À pointer sur un **disque persistant** (ex. `/var/data`) si l'hébergement en fournit un — sans quoi les données sont perdues à chaque redéploiement (voir [Déploiement](#-déploiement)) |
| `DATABASE_PATH` | — | Surcharge fine du chemin de la base (prioritaire sur `DATA_DIR`) |
| `AVATARS_DIR` | — | Surcharge fine du répertoire des avatars (prioritaire sur `DATA_DIR`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | ✅ (création admin) | Identifiants du compte admin créé au démarrage ; sans `ADMIN_PASSWORD`, la création est ignorée |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | — | Accès à l'API IGDB (recommandations enrichies) |
| `CORS_ORIGIN` | — | Origine(s) autorisée(s) pour CORS (fermé par défaut en production) |
| `REDIS_URL` | — | Adosse le rate-limiting à Redis (multi-instance). Sans elle, store mémoire mono-instance |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` | — | Fenêtre et plafond du limiteur global (défauts : 15 min / 100 req en prod) |
| `BCRYPT_ROUNDS` | — | Coût bcrypt (défaut : `12`) |

> ⚠️ **Ne jamais committer le fichier `.env`** — il est déjà ignoré par Git.

## 🧪 Tests

```bash
cd AkinatorWeb/backend
npm test         # node --test tests/
```

**144 tests** couvrent notamment la protection CSRF, l'IDOR sur les parties, l'anti-énumération
de comptes, le chaînage HMAC de l'audit, les codes de secours 2FA, le rejeu TOTP, la cohérence
du robinet quotidien, les demandes de jetons et la résolution des filtres IGDB.
Les tests tournent en `NODE_ENV=test` : aucun appel réseau réel (HIBP, IGDB) n'est effectué.

## 🔐 Sécurité

La sécurité est au cœur du projet. Mesures implémentées :

| Mesure | Détail |
|--------|--------|
| **JWT** | Access token court (HS256, 15 min) + refresh token rotatif avec détection de réutilisation. Les deux sont posés en cookies `httpOnly` / `SameSite=Strict` (header `Authorization` conservé en compatibilité) |
| **Bcrypt** | Hash des mots de passe (12 rounds) |
| **Robustesse des mots de passe** | Score `zxcvbn` ≥ 3 exigé + rejet des mots de passe présents dans les fuites connues (HaveIBeenPwned en k-anonymity, fail-open si l'API est injoignable) |
| **Invalidation de session** | Changement de mot de passe → tous les access tokens antérieurs sont refusés ; logout → révocation persistante du `jti` |
| **2FA (TOTP)** | Second facteur optionnel via `speakeasy`, 8 codes de secours à usage unique, anti-rejeu du code TOTP |
| **Helmet + CSP** | En-têtes HTTP de sécurité, CSP sans `unsafe-inline` pour les scripts, violations remontées sur `/api/csp-report` et journalisées |
| **Rate limiting** | Limitation globale + limiteurs dédiés (login, inscription, 2FA, demandes de jetons), adossables à Redis |
| **Verrouillage de compte** | Blocage temporaire après échecs de connexion répétés |
| **Anti-énumération** | Login et « mot de passe oublié » répondent de manière indifférenciée qu'un compte existe ou non |
| **CSRF** | Protection maison sur les routes sensibles (`tokens`, `a2f`, `avatar`, `admin`, `claim-daily`) |
| **Validation** | Sanitization systématique des entrées (`express-validator` + middleware global) |
| **Chiffrement** | Adresses IP chiffrées en base (AES-256-GCM) via `ENCRYPTION_KEY` dédiée, obligatoire en production (fail-secure) + migration dédiée |
| **Audit** | Journal d'audit protégé par chaînage HMAC (`AUDIT_HMAC_KEY`), vérifiable via `GET /api/admin/audit/verify`, obligatoire en production (fail-secure) |
| **RGPD** | Purge automatique des IPs de plus de 12 mois au démarrage + purge manuelle depuis le panneau admin |
| **CORS** | Origines contrôlées (fermé par défaut en production) |
| **Logs** | Journalisation sans données sensibles (IP hachées) |
| **Divulgation** | `/.well-known/security.txt` (RFC 9116) |

> 📚 Détail complet dans [`docs/securite.md`](./docs/securite.md) (posture / défense en
> profondeur) et [`docs/authentification.md`](./docs/authentification.md) (modèle de
> tokens et sessions). Politique de signalement : [`SECURITY.md`](./SECURITY.md).

## 📡 API

Base : `/api`. 🔒 = authentification requise (JWT), 👑 = réservé aux administrateurs,
🛡️ = token CSRF requis en plus (toutes les routes mutantes de `/api/tokens`, `/api/a2f`,
`/api/avatar`, `/api/admin` le sont ; ailleurs c'est signalé route par route).

### Transverse
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/health` | État de l'API |
| GET | `/api/csrf-token` 🔒 | Émission d'un token CSRF |
| POST | `/api/csp-report` | Réception des violations CSP émises par le navigateur (sans CSRF) |
| GET | `/.well-known/security.txt` | Politique de divulgation des vulnérabilités (RFC 9116) |

### Auth — `/api/auth`
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/register` | Inscription |
| POST | `/login` | Connexion |
| POST | `/verify-login-a2f` | Vérification du second facteur à la connexion |
| GET | `/me` 🔒 | Profil utilisateur |
| POST | `/claim-daily` 🔒 🛡️ | Récupérer les jetons quotidiens |
| POST | `/change-password` 🔒 | Changer le mot de passe |
| POST | `/forgot-password` | Réinitialisation du mot de passe **par code TOTP** — nécessite l'A2F activée sur le compte |
| POST | `/logout` 🔒 | Déconnexion (révoque access + refresh) |
| POST | `/refresh` | Rotation du refresh token → nouvelle paire de tokens |

### Jeu — `/api/game`
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/tree` | Arbre de décision complet |
| GET | `/node/:id/children` | Enfants d'un nœud |
| POST | `/start` 🔒 🛡️ | Démarrer une partie (consomme 1 jeton) |
| POST | `/choose` | Sélectionner une option — un `gameId` fourni doit appartenir à l'appelant |
| POST | `/recommend` | Obtenir les recommandations — idem `/choose` |
| GET | `/history` 🔒 | Historique des parties |
| GET | `/leaderboard` | Classement |
| GET | `/popular` | Jeux populaires |
| GET | `/igdb-status` | État de l'intégration IGDB |

### Jetons — `/api/tokens` 🔒
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/balance` | Solde de jetons |
| GET | `/transactions` | Historique des transactions |
| POST | `/gift` 🛡️ | Claim quotidien (même robinet que `/api/auth/claim-daily`, 3 jetons) |
| GET | `/requests` | Mes 20 dernières demandes de jetons |
| POST | `/requests` 🛡️ | Adresser une demande aux administrateurs (voir [Jetons](#-jetons)) |

### 2FA — `/api/a2f` 🔒 🛡️
`POST /setup` · `POST /verify-setup` · `POST /verify` · `POST /disable` ·
`POST /backup-codes` · `GET /status`

`verify-setup` renvoie les 8 codes de secours à l'activation ; `backup-codes` les
régénère (les anciens sont invalidés). `disable` exige le mot de passe **et** un
second facteur : code TOTP (6 chiffres) ou code de secours (10 caractères).

### Avatar — `/api/avatar` 🔒 🛡️
`POST /upload` · `DELETE /`

### Administration — `/api/admin` 👑 🛡️
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/stats` | Statistiques globales |
| GET | `/users` · `/users/:id` | Liste et détail des utilisateurs (jamais `password_hash` ni `a2f_secret`) |
| DELETE | `/users/:id` | Supprimer un utilisateur (impossible sur un autre admin) |
| POST | `/users/:id/tokens` | Attribuer des jetons (`add` / `set`, raison obligatoire) |
| POST | `/users/:id/promote` · `/demote` · `/unlock` | Promouvoir, rétrograder, déverrouiller |
| GET | `/token-requests?status=&limit=` | Demandes de jetons (défaut : `pending`) |
| POST | `/token-requests/:id/approve` | Approuver une demande (crédite le demandeur) |
| POST | `/token-requests/:id/reject` | Refuser une demande (ne crédite rien) |
| GET | `/audit?event_type=&limit=` | Journal d'audit filtrable (`event_type` accepte plusieurs types séparés par des virgules) |
| GET | `/audit/verify` | Vérification du chaînage HMAC du journal |
| GET | `/cleanup-ips` | Purge RGPD des IPs de plus de 12 mois |

## 🪙 Jetons

Aucun paiement n'est branché : les jetons s'obtiennent de **trois** façons.

- **Claim quotidien** — **3 jetons** gratuits, **une fois par jour**. Deux routes exposent le
  *même* robinet (elles partagent la colonne `last_daily_claim`) : `POST /api/auth/claim-daily`
  et `POST /api/tokens/gift`. Logique commune dans `services/dailyTokens.js` : réclamer par
  l'une consomme le claim du jour pour l'autre, et les deux répondent alors **`429`** avec le
  même message. `/gift` accepte encore un champ `amount` dans le corps pour compatibilité, mais
  **il est ignoré** — le gain est toujours de 3 jetons. Chaque claim est tracé comme transaction
  de type `daily`. Les deux routes exigent un **token CSRF**.

- **Demande à un administrateur** (`POST /api/tokens/requests`) — body
  `{ amount, reason }` avec un montant entier de **1 à 100** et un motif de **3 à 200
  caractères**. Une **seule demande en attente à la fois** (index unique partiel en base →
  **`409`** sinon), et **5 demandes par heure** au maximum. La demande est journalisée
  (`tokens.request.create`) et suivie côté utilisateur via `GET /api/tokens/requests`.
  Un administrateur l'approuve (`.../approve` → crédit + transaction `admin_grant`, audit
  `admin.token_request.approve`) ou la refuse (`.../reject`, aucun crédit). Crédit et
  changement de statut sont dans la **même transaction**, conditionnée à `status = 'pending'` :
  un double clic ou deux admins simultanés ne peuvent pas créditer deux fois.

- **Attribution directe par un administrateur** (`POST /api/admin/users/:id/tokens`) — body
  `{ action: 'add'|'set', amount, reason }`. `add` incrémente le solde, `set` le fixe à une
  valeur absolue (correction exceptionnelle). La `reason` est **obligatoire** (≤ 200 caractères).
  L'opération est tracée comme transaction de type `admin_grant` et journalisée dans l'audit
  (`admin.user.tokens`).

Côté interface, la **boutique** affiche des packs à titre de vitrine : cliquer sur un pack
n'ouvre aucun paiement mais révèle le formulaire de demande aux administrateurs.

## ☁️ Déploiement

Le projet est prêt pour **[Render](https://render.com)** via [`render.yaml`](./AkinatorWeb/render.yaml) :

- **Build** : `cd backend && npm install`
- **Start** : `cd backend && node server.js`
- **Région** : Frankfurt · **Plan** : `free`

> ⚠️ **Données éphémères.** Le plan `free` n'autorise pas de disque persistant et met le
> service en veille après inactivité : le système de fichiers est réinitialisé à chaque
> redéploiement et à chaque réveil. **La base SQLite et les avatars uploadés sont donc perdus**
> — comptes utilisateurs, parties et soldes de jetons compris. Seul le compte admin est recréé
> automatiquement au démarrage à partir d'`ADMIN_USERNAME` / `ADMIN_PASSWORD`.
> C'est un compromis assumé pour cette démonstration.
>
> Pour conserver les données : passer le service en plan `starter`, ajouter un bloc `disk:`
> monté sur `/var/data` dans [`render.yaml`](./AkinatorWeb/render.yaml) et définir
> `DATA_DIR=/var/data`. Un service avec disque ne peut pas être scalé au-delà d'une instance —
> contrainte que SQLite impose déjà de toute façon.

Variables à renseigner dans le tableau de bord Render (marquées `sync: false`) :
`ADMIN_PASSWORD`, puis `ENCRYPTION_KEY`, `AUDIT_HMAC_KEY` et `IP_HASH_SALT` — ces trois-là
exigent 64 caractères hexadécimaux, à générer avec `cd backend && node scripts/generate-keys.js`
(`generateValue` de Render ne respecte pas ce format). `JWT_SECRET` est généré automatiquement.
Les variables Twitch sont optionnelles (recommandations enrichies).

## 🧑‍💻 Développement — hooks git

Après clonage : `git config core.hooksPath .githooks` puis installer
[gitleaks](https://github.com/gitleaks/gitleaks#installing) pour le
scan de secrets en pre-commit (la CI le rejoue systématiquement).

## 📄 Licence

Distribué sous licence **MIT** (voir `AkinatorWeb/backend/package.json`).
Projet à but **pédagogique** — *AkinatorTwitch Team, Master Cybersécurité*.
