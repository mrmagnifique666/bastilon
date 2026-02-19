# Daily Sales Briefing

Génère le briefing quotidien de vente.

## Instructions

1. Vérifie le pipeline actuel via `client.smart_search`
2. Identifie les deals qui nécessitent une action aujourd'hui
3. Résume les nouvelles opportunités détectées par Scout

## Output Format
```
📊 BRIEFING VENTES — [Date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 Pipeline Actif: [nombre de deals, valeur totale]
🔥 Actions Urgentes:
  - [Deal 1]: [action requise]
  - [Deal 2]: [action requise]
📥 Nouvelles Opportunités: [leads détectés par Scout]
📈 Métriques: [calls faits, emails envoyés, réponses reçues]
🎯 Objectif du Jour: [1-2 actions prioritaires]
```
