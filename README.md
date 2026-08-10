# Cactus

Le jeu de cartes **Cactus** (aussi appelé *Dutch*, *Tamalou*, *Cabo*, *Pablo*),
jouable **à deux sur un seul téléphone**.

Le téléphone se pose à plat entre les deux joueurs, en mode portrait : chacun voit
sa moitié à l'endroit, la pioche et la défausse sont au milieu. Chaque joueur a une
**rangée privée tout au bord de son côté**, le plus loin possible de l'adversaire :
c'est là qu'arrive la carte qu'on vient de piocher, face visible, et là qu'on
regarde une carte révélée par un pouvoir — en **maintenant le doigt dessus**, la
main en coupe autour du téléphone.

Aucun compte, aucun serveur, aucune connexion : l'application est un fichier
statique qui tourne hors ligne, et s'installe depuis Safari via
**Partager → Sur l'écran d'accueil**.

## Gestes

| Geste | Effet |
|---|---|
| **Toucher** | Poser la carte piochée · choisir la cible d'un pouvoir |
| **Maintenir** | Regarder une carte à laquelle tu as droit — elle se cache dès que tu relâches. Sur une carte que le pouvoir te demande de désigner, la maintenir la choisit aussi |
| **Glisser vers le centre** | Défausse rapide — la carte suit le doigt |
| **Glisser la carte piochée** | Sur la défausse pour la jeter, sur une de tes cartes pour la poser là. Toucher la pile de défausse revient au même |
| **Toucher la carte piochée** | La recacher : elle arrive face visible, et un adversaire curieux se penche |

Au début de la manche, les deux cartes que tu as le droit de regarder sont
**entourées** : maintiens-les. En ligne, la carte que tu viens de piocher se pose à
**droite de ta rangée**, qui se décale pour lui faire place ; sur un téléphone
partagé elle reste dans la rangée tout au bord, celle qu'une main peut couvrir.

Le tour passe tout seul une fois que tu as joué — pas de bouton « Terminer ». Tu
peux dire **Cactus** après avoir joué, et encore pendant que l'autre joue, tant
qu'il n'a pas fini son tour. Réglages → *Fin de tour automatique* pour revenir à
la version stricte.

## Développement

```bash
npm install
npm run dev        # serveur de développement
npm run build      # build statique dans dist/
npm test           # tests du moteur
npm run verify     # build + tests + captures d'écran + vérifications PWA
```

`npm run verify` a besoin d'un serveur de prévisualisation :
`npm run preview` dans un autre terminal.

Le déploiement est un simple envoi de `dist/` sur n'importe quel hébergement
statique.

## Structure

```
docs/          la spécification complète des règles et du moteur (anglais)
src/engine/    le moteur, pur et sans DOM — transcription de docs/03 à docs/09
src/ui/        le rendu, sans framework : DOM conservé, patché à chaque état
tests/         rejoue la partie de référence de docs/11 et vérifie les invariants
```

Le moteur ne connaît ni le DOM, ni le temps, ni le hasard ambiant : `applyAction`
est une fonction pure, et toute l'aléa passe par une graine. C'est ce qui rend la
partie rejouable — et ce qui permettra d'ajouter plus tard des salons en ligne
sans y toucher.

**La spécification commence ici : [`docs/README.md`](docs/README.md).**

La prochaine étape — le jeu sur plusieurs appareils — est préparée dans
[`HANDOVER.md`](HANDOVER.md) : état des lieux, décisions déjà prises, ordre des
travaux et pièges à éviter.
