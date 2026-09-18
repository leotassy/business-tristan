# Ordres d’achat confidentiels — Léo et Tristan

## Démarrage
Python 3.9 ou supérieur, sans dépendance Python externe.
Depuis ce dossier : `python3 server.py`.
Ne pas ouvrir les fichiers HTML directement : le serveur est indispensable.

- Acheteur : http://127.0.0.1:8765/acheteur
- Secrétaire : http://127.0.0.1:8765/
- Administration : http://127.0.0.1:8765/admin

Les deux codes distincts sont affichés dans le terminal au démarrage. Ils changent à chaque lancement, sauf configuration via AUCTION_PIN et AUCTION_ADMIN_PIN. Ne pas les inscrire dans le code ni les partager avec les acheteurs.
Le serveur reste actif tant que le terminal reste ouvert. Ctrl+C l’arrête.
SQLite crée automatiquement data/auction.sqlite3 ; les données persistent entre les lancements.
AUCTION_DB permet de choisir une autre base, AUCTION_PORT un autre port.

## Essais sur tablettes
Sur un Wi-Fi de confiance, démarrer avec `python3 server.py --lan`.
Définir AUCTION_LAN_IP avec l’adresse locale réelle de l’ordinateur si la détection échoue.
Utiliser cette adresse avec le port 8765 dans les navigateurs des tablettes.
L’adresse 127.0.0.1 ne fonctionne que sur l’ordinateur qui héberge le serveur.
Le site n’est pas publié sur Internet. Tester avec des données fictives.

## Fonctionnement
- Acheteur : coordonnées communes, pays et indicatif téléphonique, adresse structurée, plusieurs lots et plafonds. Les pays courants sont proposés ; « Autre pays » permet de saisir un autre indicatif. Le code postal est facultatif selon le pays.
- Étapes séparées : saisie, récapitulatif et consentement acheteur, puis validation administrateur de la caution remise en personne. Aucun paiement ni document n’est collecté.
- Le dépôt groupé est atomique : tout est enregistré ou rien. Réessayer le même dépôt ne crée pas de doublon. Après rechargement d’une page dont l’envoi était incertain, vérifier auprès de l’administrateur avant de refaire le dépôt.
- Secrétaire : prix initial total, puis hausses ajoutées au prix courant, correction explicite du total, défense des ordres après annonce, adjudication, lot passé, annulation de la dernière action. Aucun nom, contact ni plafond transmis à cette console.
- À plafonds égaux, priorité au premier ordre enregistré. Les plafonds différents restent soumis à arbitrage ; ne pas inventer la règle sans accord du commissaire-priseur.
- Administrateur : connexion distincte, recherche d’acheteurs, coordonnées, plafonds, résultats, archives, création de ventes et réglage des pas.
- Une clôture archive les lots, ordres, historiques et paramètres et bloque les actions. Une nouvelle vente reprend le catalogue, sans prix ni ordres actifs. Les archives restent consultables.
- Le bouton de remise à zéro de démonstration archive aussi la vente et réalise une sauvegarde SQLite préalable.
- Les pas existants sont provisoires. Les seuils sont exclusifs et la dernière tranche n’a pas de limite. Le pas automatique doit figurer parmi les boutons.
- L’acheteur est effacé après 5 minutes d’inactivité ou 20 secondes après le reçu. L’administration se déconnecte après 5 minutes d’inactivité. Les requêtes expirent après 12 secondes.
- Utiliser l’administration sur un appareil réservé et se déconnecter avant de le confier à un acheteur.

## Fichiers
server.py : serveur HTTP, authentification et actions.
features.py : migrations, ventes, archives, dépôts multiples et paramètres.
buyer.html / buyer.js : accueil acheteurs.
index.html / shared.js : console secrétaire.
admin.html / admin.js : administration.
app.css : styles acheteur et administrateur.
login.html : connexion secrétaire.
network.js : gestion des délais réseau.
lots.json : catalogue de démonstration.
reset_demo.py : ancien utilitaire limité à data/demo-ami.sqlite3 ; préférer la clôture via l’administration (cet utilitaire ne crée pas d’archive consultable).

## Vérification
`python3 -m unittest test_shared.py test_features.py`
`node test_console.cjs` (Node.js uniquement pour ce test).
Les tests utilisent des bases temporaires séparées. Aucun ordre simulé n’est injecté dans la base de travail.

## À confirmer / limites
Attendre le catalogue exporté (format réel, photos, titres, descriptions) et les vrais pas du commissaire-priseur.
Aucune intégration Interencheres, aucun email automatique.
Le catalogue secrétaire reste également présent dans index.html : l’import futur devra unifier cette source.
Les archives et sauvegardes sont locales et non chiffrées par l’application. Elles ne remplacent pas une sauvegarde externe.
Avant production : hébergement HTTPS, comptes personnels et droits, durées de conservation, sauvegardes externes, supervision et essais de charge.
Un code partagé ne permet pas d’identifier individuellement l’administrateur. Le journal n’est pas une preuve infalsifiable.
La copie transmise à Tristan n’inclut aucune base, archive de vente ou clé d’accès. Ses changements ne se synchronisent pas automatiquement avec ceux de Léo.

Test du formulaire et des reprises après coupure : `node test_buyer.cjs`. Après un envoi incertain, le retour aux modifications est bloqué pour permettre de réessayer le même dépôt sans doublon.
