# PHASE D (DIRIGER) - COMMANDES D'EXÉCUTION

**Date:** 2026-02-13
**Objectif:** Créer le premier produit OpenClaw "Fear Is Expensive"
**Shop:** bastilon-designs.myshopify.com

---

## Commandes à Exécuter (via Telegram → Kingston)

Envoie ces commandes **une par une** à Kingston via Telegram. Attends la réponse avant la suivante.

### 1. Générer le Design

```
image.generate "Minimalist t-shirt design with bold typography. Main text: 'FEAR IS EXPENSIVE' in strong sans-serif font (Impact or Bebas Neue). Below in smaller text: '$141 lesson'. Clean design on transparent background for print-on-demand. Deep red or black text. Modern confident style, trading meme aesthetic. No background patterns." 8189338836 C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\sandbox\designs\fear-is-expensive.png
```

**Résultat attendu:** Image générée et envoyée sur Telegram + sauvegardée localement

---

### 2. Vérifier le Catalog Printful (trouver product_id exact)

```
printful.catalog t-shirts
```

**Chercher:** Bella + Canvas 3001 (devrait être product_id 71 ou similaire)
**Noter:** Le `product_id` et les `variant_ids` pour S, M, L, XL, 2XL

---

### 3. Upload Design sur Printful

**Option A (si file:// fonctionne):**
```
printful.upload_file "file://C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\sandbox\designs\fear-is-expensive.png" fear-is-expensive.png
```

**Option B (si file:// ne marche pas):**
Héberger l'image temporairement:
1. `tunnel.cloudflare 8000 http`
2. Servir l'image via un serveur local
3. Utiliser l'URL tunnel

**Résultat attendu:** URL de l'image uploadée sur Printful

---

### 4. Créer Mockup Printful

```
printful.create_mockup 71 "[URL_IMAGE_STEP_3]" "4011,4012,4013,4014,4017"
```

**Notes:**
- `71` = Product ID Bella + Canvas 3001 (vérifier step 2)
- `4011,4012,4013,4014,4017` = Variant IDs pour S, M, L, XL, 2XL (vérifier step 2)
- `[URL_IMAGE_STEP_3]` = URL retournée au step 3

**Résultat attendu:** `task_key` pour récupérer le mockup

---

### 5. Récupérer le Mockup (attendre ~30 sec)

```
printful.get_mockup [TASK_KEY_STEP_4]
```

**Résultat attendu:** URL du mockup final (image du t-shirt avec le design)

---

### 6. Créer Produit Shopify

```
shopify.create_product "Fear Is Expensive - Trading Lesson Tee" "<p>Every trader learns this the hard way: <strong>Fear costs more than action</strong>.</p><p>This shirt commemorates a $141 lesson in paper trading psychology. When you're afraid to short TDC at the peak, you watch profits evaporate. When you finally act, you win.</p><p><strong>Features:</strong></p><ul><li>Bella + Canvas 3001 (premium quality)</li><li>100% combed ring-spun cotton</li><li>Soft, comfortable, retail fit</li><li>Unisex sizing</li><li>Print-on-demand (no mass production)</li></ul><p><em>Designed by Kingston AI</em> | <strong>OpenClaw Collection</strong></p>" "OpenClaw" "Apparel" "t-shirt,openclaw,trading,meme,ai,psychology,fear-is-expensive" "29.99" "[MOCKUP_URL_STEP_5]" "draft"
```

**Résultat attendu:** Product ID + URL du produit draft

---

### 7. Vérifier le Produit

```
shopify.products 1 draft
```

**Résultat attendu:** Voir le produit créé

---

### 8. Publish le Produit (si tout est OK)

```
shopify.update_product [PRODUCT_ID_STEP_6] "" "" "" "" "" "active"
```

**Résultat attendu:** Produit LIVE sur bastilon-designs.myshopify.com

---

## Workflow Résumé

1. ✅ Générer design → `fear-is-expensive.png`
2. ✅ Trouver product_id Printful (catalog)
3. ✅ Upload design → URL Printful
4. ✅ Créer mockup → task_key
5. ✅ Récupérer mockup → mockup URL
6. ✅ Créer produit Shopify (draft) → product ID
7. ✅ Review le draft
8. ✅ Publish → LIVE!

---

## Alternatives si Bloqué

### Si `printful.upload_file` échoue:
- Héberger l'image sur un service gratuit (Imgur, Cloudinary)
- Ou utiliser `tunnel.cloudflare` + serveur HTTP local

### Si `image.generate` ne produit pas un bon design:
- Utiliser un template texte simple
- Ou créer le design manuellement avec Canva/Photoshop
- Ou utiliser Printful's design creator directement

### Si Shopify API rate limit:
- Attendre 1-2 minutes entre commandes
- Vérifier avec `shopify.shop()` que la connexion est OK

---

## Calculs de Profit (Rappel)

**Prix de vente:** $29.99
**Coûts:**
- Printful (Bella + Canvas 3001): $11.50
- Shipping (premier item): $3.99
- Shopify fee (2.9% + $0.30): $1.17

**Profit par vente:** $29.99 - $11.50 - $3.99 - $1.17 = **$13.33**

**Pour atteindre $150:**
- $150 ÷ $13.33 = **11.25 ventes** = **12 t-shirts**
- Avec Shopify $29/mois inclus: **14 ventes**

---

## Prochaines Étapes (après succès)

1. **Marketing:**
   - Post sur Moltbook avec lien
   - TikTok/Instagram Reel montrant le design
   - Story "behind the design" (la leçon de trading)

2. **Designs 2-3:**
   - "I Shorted TDC and All I Got Was This Shirt"
   - "Paper Trading Champion 2026*" (*results not guaranteed)

3. **Phase C (Contrôler):**
   - Monitor première vente
   - Vérifier qualité du produit
   - Ajuster pricing si besoin
   - Itérer sur designs

---

**Ready to execute!** 🚀

Envoie la première commande à Kingston et on y va!
