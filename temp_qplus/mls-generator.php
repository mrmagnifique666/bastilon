<?php
require_once 'db.php';
requireLogin();

$db = getDB();
$stmt = $db->prepare("SELECT credits FROM brokers WHERE id = ?");
$stmt->execute([$_SESSION['broker_id']]);
$broker = $stmt->fetch(PDO::FETCH_ASSOC);
$credits = $broker['credits'];
?>
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Description MLS AI — qplus.plus</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0f1117;
            color: #fff;
            min-height: 100vh;
        }
        .sidebar {
            width: 240px; height: 100vh; position: fixed;
            left: 0; top: 0;
            background: rgba(255,255,255,0.03);
            border-right: 1px solid rgba(255,255,255,0.08);
            display: flex; flex-direction: column; padding: 24px 16px;
        }
        .logo { font-size: 20px; font-weight: 800; color: #fff; text-decoration: none; margin-bottom: 40px; display: block; letter-spacing: -1px; }
        .logo span { color: #6366f1; }
        .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 10px; color: rgba(255,255,255,0.6); text-decoration: none; font-size: 14px; font-weight: 500; margin-bottom: 4px; transition: all 0.2s; }
        .nav-item:hover, .nav-item.active { background: rgba(99,102,241,0.15); color: #fff; }
        .nav-item.active { color: #6366f1; }
        .sidebar-footer { margin-top: auto; }
        .credit-badge { background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
        .credit-badge .label { color: rgba(255,255,255,0.5); font-size: 12px; }
        .credit-badge .count { font-size: 28px; font-weight: 700; color: #6366f1; }
        .logout { color: rgba(255,255,255,0.4); font-size: 13px; text-decoration: none; }
        .logout:hover { color: #ef4444; }
        .main { margin-left: 240px; padding: 40px; max-width: 900px; }
        .page-header { margin-bottom: 32px; }
        .page-header h1 { font-size: 24px; margin-bottom: 6px; }
        .page-header p { color: rgba(255,255,255,0.5); font-size: 14px; }
        .form-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 32px; margin-bottom: 24px; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .form-group { margin-bottom: 20px; }
        .form-group.full { grid-column: 1 / -1; }
        label { display: block; color: rgba(255,255,255,0.6); font-size: 13px; margin-bottom: 8px; }
        input, select, textarea {
            width: 100%; padding: 12px 16px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px; color: #fff; font-size: 14px;
            outline: none; transition: border-color 0.2s;
        }
        input:focus, select:focus, textarea:focus { border-color: #6366f1; }
        select option { background: #1a1f4e; }
        textarea { resize: vertical; min-height: 80px; }
        .btn-generate {
            display: flex; align-items: center; gap: 10px;
            padding: 14px 28px;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: #fff; border: none; border-radius: 10px;
            font-size: 16px; font-weight: 600; cursor: pointer;
            transition: opacity 0.2s;
        }
        .btn-generate:hover { opacity: 0.9; }
        .btn-generate:disabled { opacity: 0.4; cursor: not-allowed; }
        .result-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(99,102,241,0.3); border-radius: 16px; padding: 32px; display: none; }
        .result-card h3 { font-size: 16px; color: #818cf8; margin-bottom: 16px; }
        .result-text {
            white-space: pre-wrap; line-height: 1.7; color: rgba(255,255,255,0.85); font-size: 15px;
            background: rgba(0,0,0,0.2); border-radius: 10px; padding: 20px; margin-bottom: 16px;
        }
        .result-en { display: none; }
        .lang-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
        .lang-tab { padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); cursor: pointer; font-size: 13px; background: none; transition: all 0.2s; }
        .lang-tab.active { background: rgba(99,102,241,0.2); border-color: #6366f1; color: #fff; }
        .action-btns { display: flex; gap: 10px; }
        .btn-copy { padding: 10px 20px; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); border-radius: 8px; color: #818cf8; font-size: 14px; cursor: pointer; transition: all 0.2s; }
        .btn-copy:hover { background: rgba(99,102,241,0.25); }
        .credit-info { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: rgba(99,102,241,0.1); border-radius: 8px; font-size: 13px; color: rgba(255,255,255,0.6); margin-bottom: 20px; }
        .credit-info strong { color: #818cf8; }
        .spinner { display: inline-block; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
<div class="sidebar">
    <a href="dashboard.php" class="logo">q<span>plus</span>.plus</a>
    <a href="dashboard.php" class="nav-item">🏠 Tableau de bord</a>
    <a href="photo-editor.php" class="nav-item">📷 Retouche photos</a>
    <a href="mls-generator.php" class="nav-item active">📝 Descriptions MLS</a>
    <a href="#" class="nav-item" onclick="alert('Bientôt disponible!'); return false;">🎬 Vidéos AI</a>
    <a href="#" class="nav-item" onclick="alert('Bientôt disponible!'); return false;">📞 Réceptionniste AI</a>
    <div class="sidebar-footer">
        <div class="credit-badge">
            <div class="label">Crédits restants</div>
            <div class="count" id="creditsDisplay"><?= $credits ?></div>
        </div>
        <a href="logout.php" class="logout">↩ Se déconnecter</a>
    </div>
</div>
<div class="main">
    <div class="page-header">
        <h1>📝 Générateur de Descriptions MLS AI</h1>
        <p>Créez des descriptions professionnelles en français et anglais en 10 secondes</p>
    </div>

    <div class="form-card">
        <div class="credit-info">
            💎 Vous avez <strong><?= $credits ?> crédit<?= $credits > 1 ? 's' : '' ?></strong> disponibles — 1 crédit par description
        </div>
        <div class="form-grid">
            <div class="form-group">
                <label>Type de propriété</label>
                <select id="propType">
                    <option value="maison">Maison unifamiliale</option>
                    <option value="condo">Appartement / Condo</option>
                    <option value="duplex">Duplex / Triplex</option>
                    <option value="jumelee">Maison jumelée</option>
                    <option value="cottage">Chalet / Cottage</option>
                    <option value="commercial">Commercial</option>
                </select>
            </div>
            <div class="form-group">
                <label>Prix demandé</label>
                <input type="text" id="price" placeholder="Ex: 485 000 $">
            </div>
            <div class="form-group">
                <label>Chambres à coucher</label>
                <select id="bedrooms">
                    <option>1</option><option>2</option><option selected>3</option>
                    <option>4</option><option>5</option><option>6+</option>
                </select>
            </div>
            <div class="form-group">
                <label>Salles de bain</label>
                <select id="bathrooms">
                    <option>1</option><option selected>2</option>
                    <option>3</option><option>4+</option>
                </select>
            </div>
            <div class="form-group">
                <label>Superficie (pi²)</label>
                <input type="text" id="area" placeholder="Ex: 1 850">
            </div>
            <div class="form-group">
                <label>Ville / Quartier</label>
                <input type="text" id="location" placeholder="Ex: Gatineau, Aylmer">
            </div>
            <div class="form-group full">
                <label>Points forts et caractéristiques spéciales</label>
                <textarea id="features" placeholder="Ex: cuisine rénovée 2023, fenestration abondante, grand terrain 6000 pi², piscine creusée, garage double, secteur calme près du parc..."></textarea>
            </div>
            <div class="form-group">
                <label>Style de texte</label>
                <select id="style">
                    <option value="professionnel">Professionnel</option>
                    <option value="enthousiaste">Enthousiaste / Accrocheur</option>
                    <option value="luxe">Prestige / Luxe</option>
                    <option value="familial">Familial / Chaleureux</option>
                </select>
            </div>
            <div class="form-group">
                <label>Longueur</label>
                <select id="length">
                    <option value="courte">Courte (150 mots)</option>
                    <option value="standard" selected>Standard (250 mots)</option>
                    <option value="detaillee">Détaillée (400 mots)</option>
                </select>
            </div>
        </div>
        <button class="btn-generate" id="generateBtn" onclick="generateMLS()">
            <span>✨</span> Générer la description — 1 crédit
        </button>
    </div>

    <div class="result-card" id="resultCard">
        <h3>📄 Description générée</h3>
        <div class="lang-tabs">
            <button class="lang-tab active" onclick="showLang('fr')">🇫🇷 Français</button>
            <button class="lang-tab" onclick="showLang('en')">🇬🇧 English</button>
        </div>
        <div class="result-fr">
            <div class="result-text" id="resultFr"></div>
        </div>
        <div class="result-en" id="resultEnContainer">
            <div class="result-text" id="resultEn"></div>
        </div>
        <div class="action-btns">
            <button class="btn-copy" onclick="copyText('fr')">📋 Copier (FR)</button>
            <button class="btn-copy" onclick="copyText('en')">📋 Copier (EN)</button>
        </div>
    </div>
</div>
<script>
async function generateMLS() {
    const btn = document.getElementById('generateBtn');
    const credits = parseInt(document.getElementById('creditsDisplay').textContent);
    if (credits < 1) { alert('Crédits insuffisants!'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner">⏳</span> Génération en cours...';

    const payload = {
        type: document.getElementById('propType').value,
        price: document.getElementById('price').value,
        bedrooms: document.getElementById('bedrooms').value,
        bathrooms: document.getElementById('bathrooms').value,
        area: document.getElementById('area').value,
        location: document.getElementById('location').value,
        features: document.getElementById('features').value,
        style: document.getElementById('style').value,
        length: document.getElementById('length').value,
    };

    try {
        const res = await fetch('api/mls-generate.php', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            document.getElementById('resultFr').textContent = data.fr;
            document.getElementById('resultEn').textContent = data.en;
            document.getElementById('resultCard').style.display = 'block';
            document.getElementById('creditsDisplay').textContent = data.credits_remaining;
            document.getElementById('resultCard').scrollIntoView({behavior:'smooth'});
        } else {
            alert(data.error || 'Erreur lors de la génération.');
        }
    } catch(e) {
        alert('Erreur réseau. Réessayez.');
    }

    btn.disabled = false;
    btn.innerHTML = '<span>✨</span> Générer la description — 1 crédit';
}

function showLang(lang) {
    document.querySelectorAll('.lang-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    document.querySelector('.result-fr').style.display = lang === 'fr' ? 'block' : 'none';
    document.getElementById('resultEnContainer').style.display = lang === 'en' ? 'block' : 'none';
}

function copyText(lang) {
    const text = document.getElementById(lang === 'fr' ? 'resultFr' : 'resultEn').textContent;
    navigator.clipboard.writeText(text).then(() => alert('Texte copié!'));
}
</script>
</body>
</html>
