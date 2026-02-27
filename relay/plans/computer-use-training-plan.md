# Plan d'Amélioration Computer Use

> **Objectif**: Passer de 30% à 70-75% d'accuracy en 2 semaines
> **Date**: 2026-02-20
> **Propriétaire**: Kingston
> **Status**: Draft

---

## 1. ÉTAT ACTUEL

### Métriques de Performance
- **Accuracy estimée**: ~30%
- **Taille du code**: 1,279 lignes (src/skills/builtin/computerUse.ts)
- **Problèmes critiques identifiés**:
  - ❌ Missed clicks (coordonnées imprécises)
  - ❌ Wrong coordinates (calcul offset incorrect)
  - ❌ Lost on unknown pages (pas de profiling)
  - ❌ Pas de validation post-action
  - ❌ Pas de retry intelligent
  - ❌ Pas d'apprentissage inter-sessions

### Architecture Actuelle
```
computer.use(goal, app, chatId, maxSteps, quiet)
  ↓
1. Accessibility snapshot (A11y tree)
2. Claude vision analysis
3. Click/type/scroll actions
4. Screenshot verification
5. Repeat jusqu'à goal atteint ou maxSteps
```

### Gaps Identifiés

| Gap | Impact | Priorité |
|-----|--------|----------|
| Pas de profils de sites | High | P0 |
| Validation post-action faible | High | P0 |
| Retry naïf (pas de backoff) | Medium | P1 |
| Pas de mémoire inter-sessions | High | P0 |
| Coordonnées hardcodées (Facebook) | Medium | P1 |
| Pas de métriques historiques | Low | P2 |

---

## 2. PLAN D'AMÉLIORATION (2 SEMAINES)

### Semaine 1: Fondations + Sites Tier 1

#### Jour 1-2: Infrastructure
- [ ] **Training Logger** (relay/training-logs/computer-use-progress.json)
  - Schema: `{timestamp, site, action, result, coordinates_used, error, screenshot_url, duration_ms}`
  - API: `logTrainingAttempt(site, action, result, meta)`
  - Métriques automatiques: accuracy par site, par action, tendance 7j

- [ ] **Site Profile System** (relay/site-profiles/{domain}.json)
  - Auto-update après chaque session réussie
  - Fallback: A11y snapshot si profil absent

- [ ] **Post-Action Validation**
  - Après chaque action: screenshot + vision analysis
  - Question: "Did the action succeed? What changed on screen?"
  - Si échec: log + retry avec stratégie alternative

#### Jour 3-4: Facebook (Tier 1)
- [ ] **Action 1: Poster un status**
  - Flow: Navigate home → Click "What's on your mind" → Type text → Click "Post"
  - Validation: Screenshot post-publish, vérifier texte affiché
  - Profil: Sauvegarder coordonnées confirmées

- [ ] **Action 2: Liker un post**
  - Flow: Scroll feed → Identifier post → Click like button
  - Validation: Bouton devient bleu

- [ ] **Action 3: Commenter**
  - Flow: Click "Comment" → Type text → Submit

- [ ] **Action 4: Naviguer profil**
  - Flow: Click profile icon → Verify profile page loaded

**Target Semaine 1**: Facebook 70% accuracy (4/4 actions)

#### Jour 5-6: Gmail (Tier 1)
- [ ] **Action 1: Lire emails**
- [ ] **Action 2: Composer email**
- [ ] **Action 3: Envoyer email**

**Target Semaine 1**: Gmail 65% accuracy (3/3 actions)

#### Jour 7: Google Search (Tier 1)
- [ ] **Action 1: Recherche simple**
- [ ] **Action 2: Cliquer un résultat**

**Target Semaine 1**: Google 80% accuracy (2/2 actions)

---

### Semaine 2: Sites Tier 2 + Custom Forms

#### Jour 8-9: Twitter/X (Tier 2)
- [ ] Poster un tweet
- [ ] Liker un tweet
- [ ] Retweeter

**Target**: Twitter 60% accuracy (3/3 actions)

#### Jour 10-11: YouTube (Tier 2)
- [ ] Rechercher vidéo
- [ ] Jouer une vidéo

**Target**: YouTube 70% accuracy (2/2 actions)

#### Jour 12-14: Custom Forms (Tier 3)
- [ ] Formulaires standards (text, email, textarea)
- [ ] Dropdowns
- [ ] Checkboxes

**Target**: Forms 75% accuracy (3/3 types)

---

## 3. SYSTÈME DE MÉMOIRE

### 3.1 Training Progress Log

**Fichier**: `relay/training-logs/computer-use-progress.json`

**Schema**:
```json
{
  "sessions": [
    {
      "id": "session_20260220_014500",
      "timestamp": "2026-02-20T01:45:00Z",
      "site": "facebook.com",
      "action": "post_status",
      "goal": "Post 'Hello World' to timeline",
      "result": "success",
      "coordinates_used": [{"x": 730, "y": 217, "action": "click"}],
      "duration_ms": 12340,
      "error": null
    }
  ],
  "metrics": {
    "overall_accuracy": 0.68,
    "by_site": {
      "facebook.com": {"success": 12, "fail": 3, "accuracy": 0.80}
    },
    "trend_7d": [
      {"date": "2026-02-20", "accuracy": 0.68}
    ]
  }
}
```

### 3.2 Métriques Automatiques

**Dashboard View**:
```
╔═══════════════════════════════════════════╗
║  COMPUTER USE TRAINING DASHBOARD          ║
╠═══════════════════════════════════════════╣
║  Overall Accuracy: 68% ↗️ (+3% vs 7d ago)  ║
║  Total Sessions: 45                       ║
║  Success: 31 | Fail: 14                   ║
╠═══════════════════════════════════════════╣
║  BY SITE                                  ║
║  • facebook.com    80% (12/15)            ║
║  • gmail.com       62% (8/13)             ║
║  • google.com      85% (11/13)            ║
╚═══════════════════════════════════════════╝
```

---

## 4. PROFILS DE SITES APPRIS

### 4.1 Structure des Profils

**Fichier**: `relay/site-profiles/{domain}.json`

**Exemple: facebook.com**
```json
{
  "domain": "facebook.com",
  "last_updated": "2026-02-20T01:45:00Z",
  "success_rate": 0.80,
  "actions": {
    "post_status": {
      "flow": [
        {"step": 1, "action": "navigate", "url": "https://www.facebook.com/"},
        {"step": 2, "action": "click", "coordinates": {"x": 730, "y": 217}}
      ],
      "success_count": 12,
      "fail_count": 3
    }
  },
  "navigation": {
    "home": {"x": 725, "y": 150},
    "profile": {"x": 1585, "y": 150}
  },
  "quirks": [
    "Nav bar icons at y=150 NOT 135",
    "React intercepts checkbox clicks - use force:true"
  ]
}
```

### 4.2 Auto-Update Logic

Après chaque session **réussie**:
1. Charger profil existant (ou créer)
2. Incrémenter `success_count`
3. Mettre à jour `last_success` timestamp
4. Recalculer `success_rate`

Après chaque session **échouée**:
1. Incrémenter `fail_count`
2. Logger l'erreur dans `common_errors`

### 4.3 Utilisation des Profils

**Ordre de priorité**:

1. **Profil existe + action connue** → Utiliser flow pré-défini (rapide, haute accuracy)
2. **Profil existe + action inconnue** → Hybrid mode (navigation connue + vision pour action)
3. **Pas de profil** → Full vision mode (A11y + Claude vision)

---

## 5. MÉTRIQUES DE SUCCÈS

### Objectifs Quantitatifs

| Métrique | Baseline | Semaine 1 | Semaine 2 | Final |
|----------|----------|-----------|-----------|-------|
| **Overall Accuracy** | 30% | 50% | 65% | **70-75%** |
| **Facebook** | - | 70% | 80% | 85% |
| **Gmail** | - | 65% | 75% | 80% |
| **Google** | - | 80% | 85% | 90% |
| **Sites profiled** | 0 | 3 | 6 | 10+ |
| **Sessions logged** | 0 | 20+ | 50+ | 100+ |

### Objectifs Qualitatifs

- ✅ **Retry intelligent**: Variantes si échec (offset, sélecteur alternatif)
- ✅ **Validation systématique**: Screenshot + vision après chaque action
- ✅ **Apprentissage cumulatif**: Chaque session améliore les profils
- ✅ **Erreurs documentées**: Common errors → solutions automatiques

---

## 6. CALENDRIER D'EXÉCUTION

### Semaine 1

| Jour | Tâches | Livrables |
|------|--------|-----------|
| **J1-2** | Infrastructure | Training log + Site profiles |
| **J3-4** | Facebook | 4 actions + profil |
| **J5-6** | Gmail | 3 actions + profil |
| **J7** | Google | 2 actions + profil |

**Checkpoint**: Overall 50% → 55%

### Semaine 2

| Jour | Tâches | Livrables |
|------|--------|-----------|
| **J8-9** | Twitter/X | 3 actions + profil |
| **J10-11** | YouTube | 2 actions + profil |
| **J12-14** | Custom Forms | Generic form handling |

**Final Checkpoint**: **70-75% Overall** ✅

---

## 7. RISQUES & MITIGATIONS

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Sites changent UI | High | Profils avec fallback vision |
| Claude vision hallucine | Medium | Double validation (A11y + Vision) |
| CAPTCHA bloque | High | Détecter + escalate |

---

## 8. PROCHAINES ÉTAPES (POST-SEMAINE 2)

### Court terme (Semaine 3-4)
- Étendre à 10+ sites (LinkedIn, Reddit, GitHub, Shopify)
- CAPTCHA bypass (2captcha integration)
- Multi-monitor detection automatique

### Moyen terme (Mois 2)
- Training mode interactif (Nicolas corrige en temps réel)
- A/B testing de stratégies

### Long terme (Mois 3+)
- Computer use généralisé (n'importe quel site)
- Accuracy 90%+ sur sites appris
- Self-improving automatique

---

## 9. CONCLUSION

Ce plan transforme `computer.use` de 30% à 70-75% accuracy en 2 semaines.

**Clés du succès**:
1. ✅ Mémoire persistante (profils + logs)
2. ✅ Validation systématique
3. ✅ Retry intelligent
4. ✅ Apprentissage cumulatif
5. ✅ Métriques objectives

**Next Action**: Créer infrastructure (J1) puis commencer Facebook training (J3).

---

**Owner**: Kingston  
**Updated**: 2026-02-20 01:45 ET  
**Status**: Ready for Execution  
**Approval**: Pending Nicolas review
