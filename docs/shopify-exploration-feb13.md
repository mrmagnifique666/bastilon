# Shopify Dashboard Exploration — 2026-02-13

**Explored by:** Émile (automated script via Playwright)
**Date:** 2/12/2026, 9:03:03 PM
**Purpose:** Phase E (Exploration) of PEDC methodology for OpenClaw Shopify store

---

## Screenshots Captured

### Shopify Admin Dashboard
![Shopify Admin Dashboard](screenshots/shopify-exploration/dashboard-home.png)

### Products List Page
![Products List Page](screenshots/shopify-exploration/products-list.png)

### Add Product Form
![Add Product Form](screenshots/shopify-exploration/add-product-form.png)

### Settings - Payments
![Settings - Payments](screenshots/shopify-exploration/settings-payments.png)

### Settings - Shipping
![Settings - Shipping](screenshots/shopify-exploration/settings-shipping.png)


---

## Form Fields Detected

From the Add Product page, the following form labels were detected:

```
- Titre
- Description
- Importer des fichiers
- Catégorie
- Catégorie
- Prix
- Quantité disponible à 16 Rue de Cotignac
- Emballage
- Poids du produit
- Unité de poids
- Type
- Type
- Fournisseur
- Collections
- Balises
```


---

## Page Headings

  - Produit non enregistré
- Ajouter un produit
  - Variantes
  - Statut


---

## Notes & Observations

- Logged in successfully - URL: https://admin.shopify.com/store/bastilon-designs
- Found 4 headings
- Found 15 form labels
- Form labels detected: [
  "Titre",
  "Description",
  "Importer des fichiers",
  "Catégorie",
  "Catégorie",
  "Prix",
  "Quantité disponible à 16 Rue de Cotignac",
  "Emballage",
  "Poids du produit",
  "Unité de poids",
  "Type",
  "Type",
  "Fournisseur",
  "Collections",
  "Balises"
]

---

## API Automation Recommendations

Based on this exploration, Kingston should use the Shopify API with these approaches:

1. **Product Creation:**
   - Use `shopify.create_product(title, body_html, vendor, product_type, tags, price, image_url, status)`
   - Set `vendor: "OpenClaw"`
   - Set `product_type: "Apparel"`
   - Set `tags: "t-shirt,openclaw,ai,meme"`
   - Set `status: "draft"` initially for review before publishing

2. **Variants:**
   - Each product should have variants for sizes: S, M, L, XL, 2XL
   - All variants same price ($29.99 for Bella + Canvas 3001)
   - Printful handles inventory sync automatically

3. **Images:**
   - Generate design with `image.generate(prompt, chatId, save_to)`
   - Upload to Printful via `printful.upload_file(url, filename)`
   - Get mockup via `printful.create_mockup(product_id, image_url, variant_ids)`
   - Reference Printful mockup URL in Shopify product image

4. **Collections:**
   - Create "OpenClaw Collection" to group all designs
   - Makes browsing easier for customers
   - Use `shopify.collections()` to list, create if needed

5. **Descriptions:**
   - Keep body_html simple and SEO-friendly
   - Include humor/personality (OpenClaw brand voice)
   - Mention Bella + Canvas quality
   - Highlight print-on-demand (no mass production)

---

## Next Steps (Phase O - Organize)

With this exploration complete, Kingston can now:

1. **Organize** the exact API workflow:
   - Step 1: Generate design image
   - Step 2: Upload to Printful
   - Step 3: Create Printful mockup
   - Step 4: Create Shopify product with mockup image
   - Step 5: Add variants (S, M, L, XL, 2XL)
   - Step 6: Set pricing $29.99 all sizes
   - Step 7: Review draft → publish

2. **Direct** (Phase D): Execute first product creation
   - Design 1: "Fear Is Expensive" (trading lesson)
   - Test full workflow
   - Verify Printful sync
   - Verify product appears on storefront

3. **Control** (Phase C): Monitor results
   - Check product quality
   - Verify pricing correct
   - Test checkout flow
   - Gather feedback
   - Iterate

---

## Completion Status

- ✅ Dashboard explored
- ✅ Products section documented
- ✅ Add Product form captured
- ✅ Settings (Payments, Shipping) verified
- ✅ Screenshots saved (5 total)
- ✅ Documentation generated

**Ready for Phase O (Organize)!**
