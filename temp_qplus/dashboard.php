<?php
require_once 'db.php';
requireLogin();

$db = getDB();
$stmt = $db->prepare("SELECT * FROM brokers WHERE id = ?");
$stmt->execute([$_SESSION['broker_id']]);
$broker = $stmt->fetch(PDO::FETCH_ASSOC);

$stmt = $db->prepare("SELECT action, credits_used, created_at FROM usage_log WHERE broker_id = ? ORDER BY created_at DESC LIMIT 10");
$stmt->execute([$_SESSION['broker_id']]);
$history = $stmt->fetchAll(PDO::FETCH_ASSOC);

$action_labels = [
    'photo_edit' => '📷 Retouche photo',
    'mls_generate' => '📝 Description MLS',
    'video_create' => '🎬 Vidéo créée',
];
?>
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard — qplus.plus</title>
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
        .nav-icon { font-size: 18px; }
        .sidebar-footer {
            margin-top: auto;
        }
        .credit-badge {
            background: rgba(99,102,241,0.15);
            border: 1px solid rgba(99,102,241,0.3);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 12px;
        }
        .credit-badge .label {
            color: rgba(255,255,255,0.5);
            font-size: 12px;
            margin-bottom: 4px;
        }
        .credit-badge .count {
            font-size: 28px;
            font-weight: 700;
            color: #6366f1;
        }
        .credit-badge .sub { font-size: 12px; color: rgba(255,255,255,0.4); }
        .logout { color: rgba(255,255,255,0.4); font-size: 13px; text-decoration: none; }
        .logout:hover { color: #ef4444; }
        .main {
            margin-left: 240px;
            padding: 40px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 32px;
        }
        .header h1 { font-size: 24px; }
        .header p { color: rgba(255,255,255,0.5); font-size: 14px; margin-top: 4px; }
        .plan-badge {
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .tools-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }
        .tool-card {
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 16px;
            padding: 28px;
            text-decoration: none;
            color: #fff;
            transition: all 0.2s;
            cursor: pointer;
        }
        .tool-card:hover {
            background: rgba(99,102,241,0.1);
            border-color: rgba(99,102,241,0.3);
            transform: translateY(-2px);
        }
        .tool-card.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .tool-icon { font-size: 40px; margin-bottom: 16px; }
        .tool-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
        .tool-desc { color: rgba(255,255,255,0.5); font-size: 14px; line-height: 1.5; }
        .tool-cost {
            display: inline-block;
            margin-top: 12px;
            background: rgba(99,102,241,0.15);
            color: #818cf8;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 12px;
        }
        .tool-badge {
            display: inline-block;
            margin-top: 12px;
            background: rgba(234,179,8,0.15);
            color: #fbbf24;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 12px;
        }
        .section-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 16px;
            color: rgba(255,255,255,0.8);
        }
        .history-table {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 12px;
            overflow: hidden;
        }
        .history-table table {
            width: 100%;
            border-collapse: collapse;
        }
        .history-table th {
            padding: 14px 20px;
            text-align: left;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: rgba(255,255,255,0.4);
            border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .history-table td {
            padding: 14px 20px;
            font-size: 14px;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            color: rgba(255,255,255,0.7);
        }
        .history-table tr:last-child td { border-bottom: none; }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: rgba(255,255,255,0.3);
        }
    </style>
</head>
<body>
<div class="sidebar">
    <a href="dashboard.php" class="logo">q<span>plus</span>.plus</a>

    <a href="dashboard.php" class="nav-item active">
        <span class="nav-icon">🏠</span> Tableau de bord
    </a>
    <a href="photo-editor.php" class="nav-item">
        <span class="nav-icon">📷</span> Retouche photos
    </a>
    <a href="mls-generator.php" class="nav-item">
        <span class="nav-icon">📝</span> Descriptions MLS
    </a>
    <a href="#" class="nav-item" onclick="alert('Bientôt disponible! Mise à jour en cours.'); return false;">
        <span class="nav-icon">🎬</span> Vidéos AI
    </a>
    <a href="#" class="nav-item" onclick="alert('Bientôt disponible! Mise à jour en cours.'); return false;">
        <span class="nav-icon">📞</span> Réceptionniste AI
    </a>

    <div class="sidebar-footer">
        <div class="credit-badge">
            <div class="label">Crédits restants</div>
            <div class="count"><?= $broker['credits'] ?></div>
            <div class="sub">Plan <?= ucfirst($broker['plan']) ?></div>
        </div>
        <a href="logout.php" class="logout">↩ Se déconnecter</a>
    </div>
</div>

<div class="main">
    <div class="header">
        <div>
            <h1>Bonjour, <?= htmlspecialchars(explode(' ', $broker['name'])[0]) ?> 👋</h1>
            <p>Vos outils AI pour maximiser votre productivité</p>
        </div>
        <div class="plan-badge"><?= ucfirst($broker['plan']) ?></div>
    </div>

    <div class="tools-grid">
        <a href="photo-editor.php" class="tool-card">
            <div class="tool-icon">📷</div>
            <div class="tool-title">Retouche de Photos</div>
            <div class="tool-desc">Transformez vos photos en 30 secondes. Ciel bleu, luminosité parfaite, objets indésirables supprimés.</div>
            <span class="tool-cost">1 crédit / photo</span>
        </a>

        <a href="mls-generator.php" class="tool-card">
            <div class="tool-icon">📝</div>
            <div class="tool-title">Description MLS AI</div>
            <div class="tool-desc">Générez des descriptions professionnelles en français et anglais en 10 secondes.</div>
            <span class="tool-cost">1 crédit / description</span>
        </a>

        <a href="#" class="tool-card disabled" onclick="alert('Vidéos AI — Disponible bientôt dans votre plan Pro/Elite!'); return false;">
            <div class="tool-icon">🎬</div>
            <div class="tool-title">Vidéos de Propriété AI</div>
            <div class="tool-desc">Créez des vidéos professionnelles avec votre avatar en 2 minutes. 10 fois moins cher qu'un vidéaste.</div>
            <span class="tool-badge">Plan Pro / Elite</span>
        </a>

        <a href="#" class="tool-card disabled" onclick="alert('Réceptionniste AI — Disponible bientôt!'); return false;">
            <div class="tool-icon">📞</div>
            <div class="tool-title">Réceptionniste 24/7</div>
            <div class="tool-desc">Répondez à tous vos appels automatiquement, qualifiez les prospects, prenez les rendez-vous.</div>
            <span class="tool-badge">Bientôt disponible</span>
        </a>
    </div>

    <div class="section-title">Historique récent</div>
    <div class="history-table">
        <?php if (empty($history)): ?>
        <div class="empty-state">
            <p>Aucune action pour l'instant.</p>
            <p>Commencez par retoucher une photo!</p>
        </div>
        <?php else: ?>
        <table>
            <thead>
                <tr>
                    <th>Action</th>
                    <th>Crédits</th>
                    <th>Date</th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($history as $row): ?>
                <tr>
                    <td><?= $action_labels[$row['action']] ?? $row['action'] ?></td>
                    <td>-<?= $row['credits_used'] ?></td>
                    <td><?= date('d/m/Y H:i', strtotime($row['created_at'])) ?></td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php endif; ?>
    </div>
</div>
</body>
</html>
