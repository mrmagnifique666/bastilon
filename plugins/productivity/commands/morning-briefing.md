# Morning Briefing

Génère le briefing complet du matin.

## Instructions

Compile toutes les informations pertinentes:
1. `weather.current` — météo du jour
2. `trading.positions` — état du portefeuille
3. `goal.tree` — progression des objectifs
4. `cron.list` — tâches planifiées aujourd'hui
5. `notes.search` pour les rappels du jour
6. `content.list` avec status=scheduled — posts planifiés

## Output Format
```
☀️ BRIEFING MATIN — [Date, Jour]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌤️ Météo: [conditions, temp]
💰 Marché: [futures, tendance]
📊 Portfolio: [P&L overnight, positions]
🎯 Objectifs du Jour:
  1. [priorité #1]
  2. [priorité #2]
  3. [priorité #3]
📱 Moltbook: [post planifié aujourd'hui?]
📅 Agenda: [events/calls prévus]
💡 Rappel: [note ou insight important]
```
