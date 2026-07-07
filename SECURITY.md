# Politique de sécurité

## Signalement de vulnérabilité
Contact : sirejambon@gmail.com — réponse sous 72 h. Merci de ne pas
divulguer publiquement avant correction.

## Secrets et rotation
- `JWT_SECRET` (sessions), `ENCRYPTION_KEY` (chiffrement AES-256-GCM des IP),
  `AUDIT_HMAC_KEY` (intégrité du journal d'audit) et `IP_HASH_SALT` (logs)
  sont quatre secrets **indépendants** : la compromission de l'un n'affecte
  pas les autres. `AUDIT_HMAC_KEY` doit rester hors de portée d'un attaquant
  ayant un accès à la base, sinon le journal n'est plus inviolable.
- Génération : `node AkinatorWeb/backend/scripts/generate-keys.js`
- Rotation de la clé de chiffrement (re-chiffre les données) :
  `OLD_ENCRYPTION_KEY=... ENCRYPTION_KEY=... node AkinatorWeb/backend/scripts/rotate-encryption-key.js`
- Rotation de `JWT_SECRET` : invalide toutes les sessions (les refresh
  tokens persistés forcent une reconnexion propre).
- Aucun secret dans le dépôt : gitleaks bloque en pre-commit et en CI.

## Incident connu (leçon apprise)
Un token GitHub a fuité dans l'historique du projet. Mesures prises :
révocation du token, secret scanning gitleaks (pre-commit + CI),
séparation des secrets applicatifs.
