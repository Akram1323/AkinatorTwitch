# Spec — Retrait du paiement, audit des crédits, fiabilisation IGDB

**Date** : 2026-07-23
**Statut** : validé par le chef de projet
**Périmètre** : `AkinatorWeb/backend` + `AkinatorWeb/frontend`

## Contexte

Le site permet d'acheter des crédits (jetons) via BTCPay Server (crypto) et un
flux crypto manuel legacy (MetaMask/ethers.js). Décisions produit :

1. **Supprimer tout moyen de paiement** : seuls les admins attribuent des crédits.
2. **Auditer l'attribution de crédits** : savoir qui a reçu combien, de qui, quand.
3. **Fiabiliser les résultats jeux vidéo** : l'intégration IGDB existante renvoie
   des jeux mal catégorisés (ex. The Witcher 3 en « post-apocalyptique ») à cause
   de mappings faux/manquants et de filtres en OU inclusif.

## Décisions validées

- **Suppression totale** du code de paiement (pas de feature flag) ; git conserve
  l'historique. La table `transactions` est conservée (historique existant), le
  gift quotidien (`POST /api/tokens/gift`) est conservé (ce n'est pas un paiement).
- **Attribution admin** : la route `POST /api/admin/users/:id/tokens` accepte
  `{ action: 'add' | 'set', amount, reason }` avec `reason` obligatoire.
  `add` incrémente le solde (mode principal), `set` fixe une valeur absolue
  (correction exceptionnelle). Validation : `amount` entier, solde final ≥ 0.
- **IGDB** : quick win (correction des mappings + filtres en ET) puis résolution
  dynamique des slugs via l'API IGDB avec cache DB, dans la même PR.

## Chantier 1 — Retrait du paiement + attribution admin

### Backend — suppressions
- `services/btcpay.js` (fichier entier).
- `routes/tokens.js` : routes `/purchase`, `/verify`, `/btcpay/create`,
  `/btcpay/status/:invoiceId`, `handleBTCPayWebhook`, `verifyTransaction`,
  `PACK_EUR_PRICES`, `/prices` (adresses BTC/ETH en dur). Restent : `/balance`,
  `/gift`, `/history` (et tout ce qui n'est pas paiement).
- `server.js` : montage du webhook BTCPay (l.124-125), capture `rawBody`
  (l.59-65) si plus utilisée.
- `routes/admin.js` : routes `GET /transactions/pending`,
  `POST /transactions/:id/approve`, `POST /transactions/:id/reject` — plus
  aucun achat ne peut créer de transaction `pending`, et l'approbation
  créditait sans raison ; la route d'attribution devient la seule voie.
- `config.js` : blocs `btcpay` et `crypto`.
- `env.example.txt` : variables `BTCPAY_*`, adresses crypto.
- `package.json` : dépendance `ethers`.

### Backend — attribution admin renforcée
- `routes/admin.js` (`POST /users/:id/tokens`) : body
  `{ action: 'add'|'set', amount, reason }`, `reason` chaîne non vide obligatoire.
  `add` → `updateTokens` (delta), `set` → `setTokens`. Refus si solde final < 0.
- Enregistrer une ligne `transactions` de type `admin_grant` pour l'historique
  utilisateur.

### Frontend
- Supprimer : section Boutique (`index.html` l.108-221), fonctions de paiement
  d'`app.js` (`showShopSection`, `selectPack`, `selectCrypto`,
  `verifyManualPayment`, `createBTCPayInvoice`, `pollBTCPayStatus`,
  `PACK_PRICES`, `CRYPTO_ADDRESSES`), `js/wallet.js`, méthodes `api.js`
  (`getTokenPrices`, `purchaseTokens`, `verifyTokenPurchase`,
  `createBTCPayInvoice`, `getBTCPayStatus`), liens de navigation vers la boutique.
- Créer l'UI admin d'attribution dans le tableau utilisateurs existant
  (`index.html` l.293-313) : champ montant + add/set + raison, appel API
  `setUserTokens` à ajouter dans `api.js`.

### Tests
- Route admin : attribution `add`, `set`, refus sans `reason`, refus non-admin,
  refus `amount` invalide, refus solde final négatif.
- Non-régression : les routes de paiement supprimées renvoient 404 ;
  `/gift`, `/balance`, `/history` fonctionnent toujours ; le serveur démarre
  sans variables BTCPay.

## Chantier 2 — Audit de l'attribution de crédits

L'infra existe : `services/auditService.js` (journal chaîné HMAC, table
`audit_log`), événement `admin.user.tokens` déjà émis (`admin.js:218`) mais
pauvre (`{ targetId, amount }`).

- Enrichir `details` : `{ targetId, targetUsername, action, amount,
  oldBalance, newBalance, reason }` + `userId` = admin acteur + `ipHash`.
- `GET /api/admin/audit` : ajouter un filtre `?event_type=` pour répondre à
  « qui a reçu des crédits » ; câbler ce filtre dans l'écran admin existant.
- Tests : chaque attribution produit une entrée d'audit complète et la chaîne
  reste vérifiable (`/api/admin/audit/verify`).

## Chantier 3 — Fiabilisation IGDB

- **Corriger `FILTER_MAPPINGS`** (`services/igdb.js:160-251`) : IDs faux
  (`action`, `horreur/horror`, `mobile`, `mmo`, `battle-royale`…) et entrées
  manquantes (dont `themes.post-apocalyptic`). Un filtre sans mapping doit
  désormais **logger un warning** au lieu d'être ignoré silencieusement.
- **Filtres en ET** : `searchGamesByFilters` (`igdb.js:315-326`) doit combiner
  genre/plateforme/thème/mode en ET (clauses `where` séparées), pas en OU.
- **Résolution dynamique** : résoudre slug → ID via l'API IGDB
  (endpoints `genres`, `themes`, `platforms`, `game_modes`) avec cache dans la
  table `igdb_cache` existante ; `FILTER_MAPPINGS` devient un fallback.
  Réutiliser/adapter `services/igdbService.js` (actuellement code mort) ou le
  supprimer après en avoir extrait l'utile.
- **Cohérence de l'arbre** (`server.js:277-341`) : chaque slug proposé dans
  l'arbre doit être résoluble ; ajouter un contrôle au seed qui warn si un slug
  n'a pas de correspondance.
- Tests : IGDB mocké ; « post-apocalyptique » ⇒ la requête contient le bon
  theme ID ; combinaison de filtres ⇒ clauses en ET ; slug inconnu ⇒ warning.

## Ordre et livraison

1. PR n°1 : chantier 1 (réduit la surface, l'attribution admin devient l'unique voie).
2. PR n°2 : chantier 2 (petite, s'appuie sur la voie unique).
3. PR n°3 : chantier 3 (indépendante, parallélisable).

Chaque PR : branche dédiée, tests verts (`npm test` dans `AkinatorWeb/backend`),
CI existante (security.yml, CodeQL) verte.

## Hors périmètre

- Migration/suppression des données `transactions` existantes.
- Refonte complète de l'arbre de décision (seule la cohérence des slugs est traitée).
- Tout nouveau moyen de paiement.
