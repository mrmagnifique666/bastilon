# Call Prep

Prépare un briefing avant un appel avec un prospect ou client.

## Instructions

Recherche toute l'information disponible sur $ARGUMENTS:
1. Utilise `web.search` pour trouver leur site, LinkedIn, actualités récentes
2. Vérifie dans `client.smart_search` si on a déjà des données
3. Consulte le Knowledge Graph pour des relations existantes

## Output Format
```
📞 BRIEFING APPEL — [Nom/Entreprise]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏢 Entreprise: [nom, secteur, taille, revenue estimé]
👤 Contact: [nom, rôle, LinkedIn]
📰 Actualités: [2-3 news récentes pertinentes]
💡 Pain Points Probables: [basé sur secteur + actualités]
🎯 Notre Angle: [comment on peut aider spécifiquement]
❓ Questions à Poser: [3-5 questions ouvertes]
⚠️ Points de Vigilance: [objections probables + réponses]
```
