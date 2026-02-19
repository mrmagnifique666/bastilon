# Portfolio Review

Analyse complète du portefeuille actuel.

## Instructions

1. Vérifie les positions ouvertes via `trading.positions`
2. Calcule le P&L par position et total
3. Évalue l'exposition au risque et la diversification
4. Identifie les actions à prendre

## Output Format
```
📊 REVUE PORTEFEUILLE — [Date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 Valeur Totale: [$X]
📈 P&L Jour: [+/-$] ([+/-%])
📊 P&L Semaine: [+/-$]

📋 Positions Ouvertes:
  [TICKER] — [qty] @ $[avg] → $[current] ([+/-%])

⚠️ Risques:
  - [Position trop grosse? Corrélation? Concentration?]

🎯 Actions Recommandées:
  - [Ajuster stop-loss? Prendre des profits? Rééquilibrer?]
```
