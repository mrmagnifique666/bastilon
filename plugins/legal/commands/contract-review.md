# Contract Review

Analyse un contrat et identifie les points d'attention.

## Instructions

Analyse le contrat fourni en $ARGUMENTS:
1. Identifier les parties, l'objet et la durée
2. Vérifier chaque clause contre la checklist de revue
3. Identifier les red flags
4. Proposer des modifications

## Output Format
```
📋 REVUE CONTRAT — [Type de contrat]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 Parties: [A] ↔ [B]
📝 Objet: [résumé en 1 phrase]
📅 Durée: [début → fin, renouvellement?]
💰 Montant: [$X, modalités]

✅ Points OK:
  - [clause acceptable]

⚠️ Points d'Attention:
  - [clause problématique — pourquoi — suggestion]

🚨 Red Flags:
  - [clause dangereuse — risque — action recommandée]

📝 Modifications Suggérées:
  1. [clause X → reformulation proposée]
```
