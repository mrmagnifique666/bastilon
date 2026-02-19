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
    <title>Retouche Photos — qplus.plus</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0f1117;
            color: #fff;
            min-height: 100vh;
        }
        .sidebar {
            width: 240px;
            height: 100vh;
            position: fixed;
            left: 0;
            top: 0;
            background: rgba(255,255,255,0.03);
            border-right: 1px solid rgba(255,255,255,0.08);
            display: flex;
            flex-direction: column;
            padding: 24px 16px;
        }
        .logo {
            font-size: 20px;
            font-weight: 800;
            color: #fff;
            text-decoration: none;
            margin-bottom: 40px;
            display: block;
            letter-spacing: -1px;
        }
        .logo span { color: #6366f1; }
        .nav-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            border-radius: 10px;
            color: rgba(255,255,255,0.6);
            text-decoration: none;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 4px;
            transition: all 0.2s;
        }
        .nav-item:hover, .nav-item.active {
            background: rgba(99,102,241,0.15);
            color: #fff;
        }
        .nav-item.active { color: #6366f1; }
        .sidebar-footer { margin-top: auto; }
        .credit-badge {
            background: rgba(99,102,241,0.15);
            border: 1px solid rgba(99,102,241,0.3);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 12px;
        }
        .credit-badge .label { color: rgba(255,255,255,0.5); font-size: 12px; }
        .credit-badge .count { font-size: 28px; font-weight: 700; color: #6366f1; }
        .logout { color: rgba(255,255,255,0.4); font-size: 13px; text-decoration: none; }
        .logout:hover { color: #ef4444; }
        .main { margin-left: 240px; padding: 40px; }
        .page-header { margin-bottom: 32px; }
        .page-header h1 { font-size: 24px; margin-bottom: 6px; }
        .page-header p { color: rgba(255,255,255,0.5); font-size: 14px; }
        .editor-layout {
            display: grid;
            grid-template-columns: 1fr 340px;
            gap: 24px;
        }
        .upload-zone {
            background: rgba(255,255,255,0.03);
            border: 2px dashed rgba(99,102,241,0.3);
            border-radius: 16px;
            padding: 60px;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s;
            min-height: 400px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            position: relative;
        }
        .upload-zone:hover, .upload-zone.dragover {
            border-color: #6366f1;
            background: rgba(99,102,241,0.08);
        }
        .upload-zone input[type=file] {
            position: absolute;
            inset: 0;
            opacity: 0;
            cursor: pointer;
            width: 100%;
            height: 100%;
        }
        .upload-icon { font-size: 64px; margin-bottom: 16px; }
        .upload-title { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
        .upload-sub { color: rgba(255,255,255,0.4); font-size: 14px; }
        .preview-container { position: relative; width: 100%; }
        .compare-slider {
            position: relative;
            user-select: none;
            display: none;
        }
        .compare-slider img {
            width: 100%;
            border-radius: 12px;
            display: block;
        }
        .compare-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 50%;
            height: 100%;
            overflow: hidden;
        }
        .compare-overlay img {
            width: 200%;
            border-radius: 12px 0 0 12px;
        }
        .compare-handle {
            position: absolute;
            top: 0;
            left: 50%;
            width: 4px;
            height: 100%;
            background: #fff;
            cursor: ew-resize;
            transform: translateX(-50%);
        }
        .compare-handle::after {
            content: '⟷';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #fff;
            color: #000;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
        }
        .label-before, .label-after {
            position: absolute;
            bottom: 12px;
            background: rgba(0,0,0,0.6);
            color: #fff;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 12px;
        }
        .label-before { left: 12px; }
        .label-after { right: 12px; }
        .controls {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 16px;
            padding: 24px;
        }
        .controls h3 { font-size: 16px; margin-bottom: 20px; }
        .option-group { margin-bottom: 20px; }
        .option-group label {
            display: block;
            color: rgba(255,255,255,0.6);
            font-size: 13px;
            margin-bottom: 10px;
            font-weight: 500;
        }
        .options-grid {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .option-btn {
            padding: 14px 16px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
            color: rgba(255,255,255,0.7);
            font-size: 14px;
            cursor: pointer;
            text-align: left;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .option-btn:hover, .option-btn.selected {
            background: rgba(99,102,241,0.2);
            border-color: #6366f1;
            color: #fff;
        }
        .option-btn .icon { font-size: 20px; }
        .option-btn .label-text { flex: 1; }
        .option-btn .label-text strong { display: block; font-size: 14px; }
        .option-btn .label-text span { font-size: 12px; color: rgba(255,255,255,0.4); }
        .option-btn.selected .label-text span { color: rgba(99,102,241,0.7); }
        .room-selector {
            display: none;
            margin-top: 8px;
        }
        .room-selector.visible { display: block; }
        .room-select {
            width: 100%;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(99,102,241,0.4);
            border-radius: 10px;
            color: #fff;
            padding: 12px 14px;
            font-size: 14px;
            outline: none;
            appearance: none;
            cursor: pointer;
        }
        .room-select option { background: #1a1b2e; color: #fff; }
        .room-select:focus { border-color: #6366f1; }
        .custom-prompt {
            width: 100%;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 8px;
            color: #fff;
            padding: 10px 12px;
            font-size: 13px;
            resize: vertical;
            outline: none;
            min-height: 70px;
        }
        .custom-prompt::placeholder { color: rgba(255,255,255,0.3); }
        .custom-prompt:focus { border-color: #6366f1; }
        .btn-process {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: #fff;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
            margin-top: 8px;
        }
        .btn-process:hover { opacity: 0.9; }
        .btn-process:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-download {
            width: 100%;
            padding: 12px;
            background: rgba(34,197,94,0.15);
            border: 1px solid rgba(34,197,94,0.3);
            color: #86efac;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 10px;
            text-align: center;
            text-decoration: none;
            display: none;
        }
        .credit-info {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px;
            background: rgba(99,102,241,0.1);
            border-radius: 8px;
            font-size: 13px;
            color: rgba(255,255,255,0.6);
            margin-bottom: 16px;
        }
        .credit-info strong { color: #818cf8; }
        .status-msg {
            padding: 12px;
            border-radius: 8px;
            font-size: 14px;
            margin-top: 10px;
            display: none;
        }
        .status-msg.loading {
            background: rgba(99,102,241,0.15);
            color: #818cf8;
            display: block;
        }
        .status-msg.success {
            background: rgba(34,197,94,0.15);
            color: #86efac;
            display: block;
        }
        .status-msg.error {
            background: rgba(239,68,68,0.15);
            color: #fca5a5;
            display: block;
        }
        .spinner {
            display: inline-block;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .change-photo-btn {
            margin-top: 12px;
            background: none;
            border: 1px solid rgba(255,255,255,0.2);
            color: rgba(255,255,255,0.5);
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            cursor: pointer;
            display: none;
        }
        .change-photo-btn:hover { color: #fff; border-color: rgba(255,255,255,0.4); }
        .mobile-header {
            display: none;
            background: rgba(255,255,255,0.03);
            border-bottom: 1px solid rgba(255,255,255,0.08);
            padding: 16px 20px;
            align-items: center;
            justify-content: space-between;
        }
        .mobile-header .logo { margin-bottom: 0; font-size: 18px; }
        .mobile-header .mobile-credits { color: #6366f1; font-weight: 700; font-size: 16px; }
        .mobile-back { color: rgba(255,255,255,0.5); text-decoration: none; font-size: 14px; }
        @media (max-width: 768px) {
            .sidebar { display: none; }
            .mobile-header { display: flex; }
            .main { margin-left: 0; padding: 20px; }
            .editor-layout {
                grid-template-columns: 1fr;
                gap: 16px;
            }
            .upload-zone { padding: 40px 20px; min-height: 250px; }
            .page-header h1 { font-size: 20px; }
            .controls { padding: 20px; }
            .option-btn { padding: 12px 14px; }
            .room-select { padding: 10px 12px; }
        }
    </style>
</head>
<body>
<div class="mobile-header">
    <a href="dashboard.php" class="mobile-back">← Retour</a>
    <span class="logo">q<span>plus</span>.plus</span>
    <span class="mobile-credits"><?= $credits ?> 💎</span>
</div>
<div class="sidebar">
    <a href="dashboard.php" class="logo">q<span>plus</span>.plus</a>
    <a href="dashboard.php" class="nav-item">🏠 Tableau de bord</a>
    <a href="photo-editor.php" class="nav-item active">📷 Retouche photos</a>
    <a href="mls-generator.php" class="nav-item">📝 Descriptions MLS</a>
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
        <h1>📷 Retouche de Photos AI</h1>
        <p>Transformez vos photos de propriétés en images professionnelles en 30 secondes</p>
    </div>

    <div class="editor-layout">
        <div>
            <div class="upload-zone" id="uploadZone">
                <input type="file" id="photoInput" accept="image/jpeg,image/png,image/webp">
                <div class="upload-icon">📸</div>
                <div class="upload-title">Déposez votre photo ici</div>
                <div class="upload-sub">ou cliquez pour choisir un fichier<br>JPEG, PNG ou WEBP — Max 10MB</div>
            </div>
            <div class="compare-slider" id="compareSlider">
                <img id="resultImg" src="" alt="Résultat">
                <div class="compare-overlay" id="compareOverlay">
                    <img id="originalImgOverlay" src="" alt="Original">
                </div>
                <div class="compare-handle" id="compareHandle"></div>
                <span class="label-before">Avant</span>
                <span class="label-after">Après</span>
            </div>
            <button class="change-photo-btn" id="changePhotoBtn">🔄 Changer de photo</button>
        </div>

        <div class="controls">
            <h3>⚙️ Type de retouche</h3>

            <div class="credit-info">
                <span>💎</span>
                <span>Vous avez <strong><?= $credits ?> crédit<?= $credits > 1 ? 's' : '' ?></strong></span>
            </div>

            <div class="option-group">
                <label>Choisissez une option</label>
                <div class="options-grid">
                    <div class="option-btn selected" data-val="eclairage">
                        <span class="icon">💡</span>
                        <div class="label-text">
                            <strong>Améliorer l'éclairage</strong>
                            <span>Luminosité, contraste, couleurs professionnelles</span>
                        </div>
                    </div>
                    <div class="option-btn" data-val="declutter">
                        <span class="icon">🧹</span>
                        <div class="label-text">
                            <strong>Retirer les objets superflus</strong>
                            <span>Enlever poubelles, voitures, encombrement</span>
                        </div>
                    </div>
                    <div class="option-btn" data-val="homestaging">
                        <span class="icon">🛋️</span>
                        <div class="label-text">
                            <strong>Home Staging virtuel</strong>
                            <span>Meubler et décorer une pièce vide</span>
                        </div>
                    </div>
                </div>

                <!-- Room selector — appears only for Home Staging -->
                <div class="room-selector" id="roomSelector">
                    <label style="margin-top:12px; margin-bottom:8px;">Quelle pièce?</label>
                    <select class="room-select" id="roomSelect">
                        <option value="salon">🛋️ Salon / Salle de séjour</option>
                        <option value="cuisine">🍳 Cuisine</option>
                        <option value="chambre_principale">🛏️ Chambre principale</option>
                        <option value="chambre_secondaire">🛌 Chambre secondaire</option>
                        <option value="salle_de_bain">🚿 Salle de bain</option>
                        <option value="salle_a_manger">🍽️ Salle à manger</option>
                        <option value="bureau">💼 Bureau / Home office</option>
                        <option value="sous_sol">🏠 Sous-sol / Salle de jeux</option>
                        <option value="exterieur">🌿 Terrasse / Extérieur</option>
                    </select>
                </div>
            </div>

            <div class="option-group">
                <label>Instructions supplémentaires (optionnel)</label>
                <textarea class="custom-prompt" id="customPrompt"
                    placeholder="Ex: Ajouter des plantes vertes, tonalité chaleureuse, style scandinave..."></textarea>
            </div>

            <button class="btn-process" id="processBtn" disabled>
                🪄 Retoucher la photo — 1 crédit
            </button>

            <a class="btn-download" id="downloadBtn" href="#" target="_blank">
                📱 Voir la photo retouchée
            </a>
            <div class="save-tip" id="saveTip" style="display:none; padding:10px; margin-top:8px; background:rgba(99,102,241,0.1); border-radius:8px; font-size:12px; color:rgba(255,255,255,0.5); text-align:center;">
                💡 Appui long sur l'image → Enregistrer dans Photos
            </div>

            <div class="status-msg" id="statusMsg"></div>
        </div>
    </div>
</div>

<script>
const photoInput = document.getElementById('photoInput');
const uploadZone = document.getElementById('uploadZone');
const compareSlider = document.getElementById('compareSlider');
const resultImg = document.getElementById('resultImg');
const originalImgOverlay = document.getElementById('originalImgOverlay');
const compareOverlay = document.getElementById('compareOverlay');
const compareHandle = document.getElementById('compareHandle');
const processBtn = document.getElementById('processBtn');
const downloadBtn = document.getElementById('downloadBtn');
const statusMsg = document.getElementById('statusMsg');
const roomSelector = document.getElementById('roomSelector');
const changePhotoBtn = document.getElementById('changePhotoBtn');
let selectedOption = 'eclairage';
let originalFile = null;
let originalDataURL = null;

// Option buttons
document.querySelectorAll('.option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedOption = btn.dataset.val;
        // Show/hide room selector
        if (selectedOption === 'homestaging') {
            roomSelector.classList.add('visible');
        } else {
            roomSelector.classList.remove('visible');
        }
    });
});

// File upload
photoInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
});

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
    if (file.size > 10 * 1024 * 1024) {
        alert('Fichier trop grand (max 10MB)');
        return;
    }
    originalFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
        originalDataURL = e.target.result;
        uploadZone.style.display = 'none';
        compareSlider.style.display = 'block';
        resultImg.src = originalDataURL;
        originalImgOverlay.src = originalDataURL;
        compareOverlay.style.width = '50%';
        processBtn.disabled = false;
        downloadBtn.style.display = 'none';
        statusMsg.className = 'status-msg';
        changePhotoBtn.style.display = 'inline-block';
    };
    reader.readAsDataURL(file);
}

// Change photo button
changePhotoBtn.addEventListener('click', () => {
    uploadZone.style.display = 'flex';
    compareSlider.style.display = 'none';
    changePhotoBtn.style.display = 'none';
    processBtn.disabled = true;
    downloadBtn.style.display = 'none';
    statusMsg.className = 'status-msg';
    originalFile = null;
    photoInput.value = '';
});

// Compare slider drag
let isDragging = false;
compareHandle.addEventListener('mousedown', () => isDragging = true);
document.addEventListener('mouseup', () => isDragging = false);
document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = compareSlider.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100));
    compareOverlay.style.width = pct + '%';
    compareHandle.style.left = pct + '%';
});

// Process
processBtn.addEventListener('click', async () => {
    if (!originalFile) return;
    const credits = parseInt(document.getElementById('creditsDisplay').textContent);
    if (credits < 1) {
        setStatus('error', 'Vous n\'avez plus de crédits. Contactez-nous pour en obtenir davantage.');
        return;
    }

    processBtn.disabled = true;
    setStatus('loading', selectedOption === 'homestaging'
        ? '<span class="spinner">⏳</span> Home staging 2 étapes — Analyse de la pièce...'
        : '<span class="spinner">⏳</span> Étape 1/2 — Analyse intelligente de la photo...');
    downloadBtn.style.display = 'none';

    // Update status messages based on mode
    const isStaging = selectedOption === 'homestaging';
    const statusTimer = setTimeout(() => {
        if (statusMsg.classList.contains('loading')) {
            statusMsg.innerHTML = isStaging
                ? '<span class="spinner">⏳</span> Étape 1/2 — Vidage de la pièce en cours...'
                : '<span class="spinner">⏳</span> Étape 2/2 — Retouche avec prompt personnalisé... (30-60s)';
        }
    }, 8000);
    const statusTimer2 = isStaging ? setTimeout(() => {
        if (statusMsg.classList.contains('loading')) {
            statusMsg.innerHTML = '<span class="spinner">⏳</span> Étape 2/2 — Home staging en cours...';
        }
    }, 45000) : null;

    const formData = new FormData();
    formData.append('photo', originalFile);
    formData.append('option', selectedOption);
    formData.append('room', document.getElementById('roomSelect').value);
    formData.append('custom', document.getElementById('customPrompt').value);

    try {
        const res = await fetch('api/gemini-edit.php', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        clearTimeout(statusTimer);
        if (statusTimer2) clearTimeout(statusTimer2);
        if (data.success && data.image_url) {
            resultImg.src = data.image_url + '?t=' + Date.now();
            setStatus('success', '✅ Photo retouchée avec succès! Glissez le curseur pour comparer.');
            downloadBtn.href = data.image_url;
            downloadBtn.style.display = 'block';
            document.getElementById('saveTip').style.display = 'block';
            document.getElementById('creditsDisplay').textContent = data.credits_remaining;
            compareOverlay.style.width = '50%';
            compareHandle.style.left = '50%';
            processBtn.disabled = false;
        } else {
            setStatus('error', data.error || 'Erreur lors du traitement. Réessayez.');
            processBtn.disabled = false;
        }
    } catch (err) {
        clearTimeout(statusTimer);
        if (statusTimer2) clearTimeout(statusTimer2);
        setStatus('error', 'Erreur réseau. Vérifiez votre connexion.');
        processBtn.disabled = false;
    }
});

function setStatus(type, msg) {
    statusMsg.className = 'status-msg ' + type;
    statusMsg.innerHTML = msg;
}
</script>
</body>
</html>
