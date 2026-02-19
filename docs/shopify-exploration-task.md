# SHOPIFY DASHBOARD EXPLORATION TASK

**Date:** 2026-02-13
**Assigned to:** Émile (Claude Code CLI)
**Requested by:** Kingston + Nicolas
**Status:** PENDING EXECUTION

---

## Context

Nicolas and Kingston are building a Shopify + Printful dropshipping store for OpenClaw t-shirts. Following PEDC methodology (Plan, Explore, Organize, Direct, Control):

- ✅ **Phase P (Plan):** Completed — pricing research, profit margins calculated, target: 14 sales = $150 profit
- 🔄 **Phase E (Explore):** IN PROGRESS — explore Shopify dashboard to understand interface before automation
- ⏳ **Phase O (Organize):** Blocked — waiting for exploration results
- ⏳ **Phase D (Direct):** Blocked
- ⏳ **Phase C (Control):** Blocked

---

## Objective

Document the Shopify admin interface so Kingston can create products autonomously via the Shopify API.

---

## Tasks

### 1. Navigate to Shopify Admin
- URL: https://admin.shopify.com
- Login should auto-complete (trial account created recently)
- Screenshot: Dashboard homepage

### 2. Explore Products Section
- Click sidebar menu → "Products"
- Screenshot: Product list (likely empty)
- Click "Add product" button
- Screenshot: Complete product creation form

### 3. Document All Product Fields

**Required to capture:**
- Title (required?)
- Description/Body HTML (rich text editor?)
- Media (image upload interface)
- Pricing (price, compare at price, cost per item)
- Inventory (SKU, barcode, track quantity option)
- Shipping (weight, dimensions)
- **Variants** (HOW to add S, M, L, XL, 2XL?)
- Product organization (product type, vendor, collections, tags)
- SEO (meta title, description, URL handle)
- Status (active, draft, archived)

### 4. Test Variants Workflow
- How to add a new variant?
- Can sizes be bulk-added (S, M, L, XL, 2XL)?
- Does each variant have separate pricing/images?
- Screenshot: Variants panel

### 5. Collections (if accessible)
- Sidebar → Collections
- How to create a collection?
- Screenshot

### 6. Relevant Settings
- Settings → Payments (is Shopify Payments active?)
- Settings → Shipping (are zones configured?)
- Screenshots of both

---

## Deliverable Format

Create file: `docs/shopify-exploration-feb13.md`

```markdown
# Shopify Dashboard Exploration — 13 Feb 2026

## Dashboard Home
[Screenshot: dashboard-home.png]
- Main navigation: ...
- Quick actions: ...

## Products Section

### Product List
[Screenshot: products-list.png]
- Current state: ...

### Add Product Form
[Screenshot: add-product-form.png]

**Required fields:**
- Title: Yes/No
- Description: Yes/No
- Price: Yes/No
- ...

**Optional fields:**
- ...

**Variants workflow:**
1. Step 1: [description + screenshot]
2. Step 2: ...
3. ...

## Collections
[Screenshot: collections.png]
- ...

## Settings

### Payments
[Screenshot: settings-payments.png]
- Status: Active/Inactive
- Provider: Shopify Payments / Other

### Shipping
[Screenshot: settings-shipping.png]
- Zones configured: ...

## API Automation Notes

**Fields available via API:**
- ...

**Limitations:**
- ...

**Recommendations for Kingston:**
- Use `shopify.create_product(...)` with these fields: ...
- Variants should be created as: ...
- Image upload via: ...
```

---

## Priority

**HIGH** — Blocks Phase O (Organize) and Phase D (Direct)

---

## Notes

- If login fails, document exact error
- If trial expired, mention it clearly
- Take clear screenshots (no sensitive data visible)
- Focus on info USEFUL for API automation
- Store screenshots in: `docs/screenshots/shopify-exploration/`

---

## Execution Instructions

1. Use browser automation (Puppeteer via Kingston's browser tools OR manual navigation)
2. Document everything systematically
3. Save all screenshots with descriptive filenames
4. Create the final markdown document
5. Notify Nicolas + Kingston when complete
