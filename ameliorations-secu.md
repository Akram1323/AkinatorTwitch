# Améliorations de sécurité — AkinatorTwitch

> Document de synthèse : posture de sécurité actuelle du projet et implémentations à ajouter pour renforcer (et « vendre ») le volet cybersécurité.

Constat de départ : **le socle est déjà sérieux** pour un projet Master Cyber. On liste d'abord l'existant à valoriser, puis les manques et les implémentations à ajouter, classées par impact.

---

## Ce que le projet fait déjà bien (à valoriser tel quel)

- **Helmet** avec CSP sans `unsafe-inline` sur les scripts + **HSTS preload**
- **bcrypt** 12 rounds, politique de mot de passe forte (`express-validator`)
- **Rate limiting** différencié (global / login anti-brute-force / register / paiement)
- **2FA TOTP** (speakeasy + QR code)
- **CSRF** par token utilisateur, **JWT** HS256 avec blacklist de révocation
- **AES-256-GCM** pour chiffrer les IP + **SHA-256** pour les logs → conformité **RGPD** (consentement, minimisation, purge automatique des IP)
- **Requêtes préparées** (better-sqlite3) → SQLi neutralisée *par conception* (bon argument à formuler explicitement)
- **HMAC-SHA256** sur les webhooks BTCPay

Le message : « on ne colle pas des libs, on a une défense en profondeur cohérente ».

---

## Tier 1 — Fort impact, différenciant

### 1. Authentification moderne : access court + refresh rotatif en cookies `httpOnly`
Aujourd'hui : un seul JWT 24 h, blacklist *en mémoire* (perdue au redémarrage, ne scale pas). Le token est probablement stocké côté client en `localStorage` → **vol trivial par XSS**.

→ Access token 15 min + refresh token avec **rotation + détection de réutilisation** (reuse detection = on invalide toute la famille si un vieux refresh resurgit → détecte le vol). Cookies `httpOnly; Secure; SameSite=Strict`. Blacklist/refresh **persistés en base**.

*Pourquoi ça compte :* c'est LA question qu'un jury pose (« où stockez-vous le JWT ? »). Une bonne réponse fait la différence.

### 2. Journal d'audit inviolable (tamper-evident)
Aujourd'hui `securityLogger` fait juste du `console.log`.

→ Table `audit_log` **append-only** avec **chaînage de hash** (`hash_n = SHA256(event_n || hash_n-1)`) : login, changement de rôle, actions admin, paiements. Toute altération casse la chaîne.

*Pourquoi ça compte :* traçabilité / forensics / non-répudiation — vocabulaire qui parle directement à un jury cyber.

---

## Tier 2 — Durcissement de l'authentification

### 3. Détection de mots de passe compromis
Via **HaveIBeenPwned** (API k-anonymity, on n'envoie que 5 caractères du hash SHA-1) + score **zxcvbn**. Refuser un mot de passe déjà présent dans une fuite connue.

### 4. 2FA renforcée
**Codes de secours** (hashés en base, usage unique), **anti-rejeu TOTP** (mémoriser le dernier `step` utilisé), et rate-limit dédié sur la vérification 2FA.

### 5. Anti-énumération de comptes
`/register` renvoie `409 « identifiant déjà utilisé »` → un attaquant peut **énumérer les comptes existants**. Uniformiser les réponses et **égaliser les temps de réponse** (timing-safe) sur login/register.

---

## Tier 3 — DevSecOps (très valorisé, et il y a un cas réel)

### 6. Pipeline CI de sécurité
D'autant plus pertinent qu'un **token GitHub a fuité** dans ce projet :

- **Secret scanning** : `gitleaks` en pre-commit + CI (aurait bloqué le token `ghp_…`)
- **SAST** : CodeQL ou Semgrep
- **Dépendances** : `npm audit` + Dependabot, `npm ci` sur lockfile
- **DAST** : scan **OWASP ZAP baseline** sur l'app déployée

*Pourquoi ça compte :* on transforme l'incident du token en démonstration de maturité (« voici la mesure qui l'empêche de se reproduire »).

### 7. Gestion des secrets propre
`ENCRYPTION_KEY` est aujourd'hui **dérivée du `JWT_SECRET`** (un seul SHA-256, sel statique) → une seule fuite compromet tout. La séparer, documenter la **rotation de clés**, `.env` hors Git (déjà fait).

---

## Tier 4 — Robustesse applicative (quick wins)

### 8. Upload d'avatar durci
`multer` / `sharp` : valider les **magic bytes** (pas juste l'extension), **re-encoder** via sharp, **supprimer l'EXIF**, limiter dimensions/poids (anti-« compression bomb »), nom de fichier généré (anti path-traversal). Vecteur d'attaque classique qu'un jury adore tester.

### 9. Stores persistants (Redis)
Pour rate-limit **et** CSRF : les `Map` en mémoire ne survivent pas à un redémarrage ni au multi-instance (Render redéploie souvent).

### 10. En-têtes & découverte
`Permissions-Policy`, CSP avec `report-to`, et un fichier **`/.well-known/security.txt`** (contact sécurité) — détail qui montre le souci du standard.

---

## Priorisation recommandée

Faire **#1 (cookies httpOnly + refresh rotation)**, **#2 (audit log chaîné)** et **#6 (CI sécurité + secret scanning)** : ce trio couvre **auth**, **traçabilité** et **supply-chain** — les trois axes qu'un jury cyber note. Les #3 / #4 / #8 sont des quick wins pour étoffer la démo.

| # | Amélioration | Impact | Effort |
|---|--------------|--------|--------|
| 1 | Access court + refresh rotatif (cookies httpOnly) | Élevé | Moyen |
| 2 | Journal d'audit inviolable (hash chaîné) | Élevé | Moyen |
| 6 | Pipeline CI sécurité (SAST/DAST/secrets) | Élevé | Moyen |
| 3 | Mots de passe compromis (HIBP + zxcvbn) | Moyen | Faible |
| 4 | 2FA renforcée (backup codes, anti-rejeu) | Moyen | Faible |
| 5 | Anti-énumération de comptes | Moyen | Faible |
| 8 | Upload avatar durci | Moyen | Faible |
| 9 | Stores persistants (Redis) | Moyen | Moyen |
| 7 | Séparation / rotation des secrets | Moyen | Faible |
| 10 | En-têtes + security.txt | Faible | Faible |
