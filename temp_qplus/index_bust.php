<?php /* CACHE_BUST_1771444796557 */ ?><?php
// Diagnostic mode — ?diag=1
if (isset($_GET['diag']) && $_GET['diag'] === '1') {
    header('Content-Type: application/json');
    $result = [
        'php_version' => PHP_VERSION,
        'sqlite3_loaded' => extension_loaded('sqlite3'),
        'pdo_sqlite_loaded' => extension_loaded('pdo_sqlite'),
        'pdo_drivers' => PDO::getAvailableDrivers(),
        'data_dir' => __DIR__ . '/data',
        'data_dir_exists' => is_dir(__DIR__ . '/data'),
        'data_dir_writable' => is_writable(__DIR__ . '/data'),
        'app_dir_writable' => is_writable(__DIR__),
        'db_php_version' => 'inline_v3',
        'timestamp' => date('Y-m-d H:i:s')
    ];

    try {
        $dbDir = __DIR__ . '/data';
        if (!is_dir($dbDir)) @mkdir($dbDir, 0777, true);
        $dbPath = $dbDir . '/brokers.db';
        $pdo = new PDO("sqlite:$dbPath");
        $pdo->exec("PRAGMA journal_mode=WAL");
        $result['sqlite_connect'] = 'SUCCESS';
        $result['db_file'] = $dbPath;

        $pdo->exec("CREATE TABLE IF NOT EXISTS brokers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            company TEXT DEFAULT '',
            plan TEXT DEFAULT 'starter',
            credits INTEGER DEFAULT 10,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )");
        $result['tables'] = 'created';

        $count = $pdo->query("SELECT COUNT(*) FROM brokers")->fetchColumn();
        $result['broker_count'] = $count;
    } catch (Exception $e) {
        $result['sqlite_error'] = $e->getMessage();
    }

    echo json_encode($result, JSON_PRETTY_PRINT);
    exit;
}

require_once 'db.php';

$error = '';
$success = '';
$mode = $_GET['mode'] ?? 'login';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';
    $email = trim($_POST['email'] ?? '');
    $password = $_POST['password'] ?? '';

    if ($action === 'login') {
        try {
            $db = getDB();
            $stmt = $db->prepare("SELECT * FROM brokers WHERE email = ?");
            $stmt->execute([$email]);
            $broker = $stmt->fetch(PDO::FETCH_ASSOC);

            if ($broker && password_verify($password, $broker['password_hash'])) {
                $_SESSION['broker_id'] = $broker['id'];
                $_SESSION['broker_name'] = $broker['name'];
                $_SESSION['broker_plan'] = $broker['plan'];
                $_SESSION['broker_credits'] = $broker['credits'];
                header('Location: dashboard.php');
                exit;
            } else {
                $error = 'Email ou mot de passe invalide.';
            }
        } catch (Exception $e) {
            $error = 'Erreur de connexion: ' . $e->getMessage();
        }
    } elseif ($action === 'register') {
        $name = trim($_POST['name'] ?? '');
        $company = trim($_POST['company'] ?? '');

        if (empty($name) || empty($email) || empty($password)) {
            $error = 'Tous les champs sont requis.';
        } elseif (strlen($password) < 8) {
            $error = 'Le mot de passe doit avoir au moins 8 caractères.';
        } else {
            try {
                $db = getDB();
                initDB();
                $hash = password_hash($password, PASSWORD_DEFAULT);
                $stmt = $db->prepare("INSERT INTO brokers (email, password_hash, name, company, credits) VALUES (?, ?, ?, ?, 10)");
                $stmt->execute([$email, $hash, $name, $company]);
                $success = 'Compte créé! Vous pouvez maintenant vous connecter.';
                $mode = 'login';
            } catch (PDOException $e) {
                if ($e->getCode() == 23000) {
                    $error = 'Cet email est déjà utilisé.';
                } else {
                    $error = 'Erreur lors de la création du compte: ' . $e->getMessage();
                }
            }
        }
    }
}

if (isLoggedIn()) {
    header('Location: dashboard.php');
    exit;
}
?>
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>qplus.plus — Connexion Courtiers</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f4e 50%, #0d1226 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 48px;
            width: 100%;
            max-width: 420px;
            backdrop-filter: blur(20px);
        }
        .logo { text-align: center; margin-bottom: 32px; }
        .logo a { display: inline-block; font-size: 28px; font-weight: 800; color: #fff; text-decoration: none; letter-spacing: -1px; }
        .logo span { color: #6366f1; }
        .logo small { display: block; color: rgba(255,255,255,0.5); font-size: 13px; font-weight: 400; margin-top: 4px; }
        h2 { color: #fff; font-size: 22px; margin-bottom: 24px; text-align: center; }
        .tabs { display: flex; gap: 8px; margin-bottom: 28px; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 10px; }
        .tab { flex: 1; padding: 10px; text-align: center; border-radius: 8px; cursor: pointer; color: rgba(255,255,255,0.5); font-size: 14px; font-weight: 500; text-decoration: none; transition: all 0.2s; }
        .tab.active { background: #6366f1; color: #fff; }
        .form-group { margin-bottom: 16px; }
        label { display: block; color: rgba(255,255,255,0.7); font-size: 13px; margin-bottom: 6px; }
        input { width: 100%; padding: 12px 16px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; color: #fff; font-size: 15px; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: #6366f1; }
        input::placeholder { color: rgba(255,255,255,0.3); }
        .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; transition: opacity 0.2s; }
        .btn:hover { opacity: 0.9; }
        .error { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; padding: 12px 16px; border-radius: 10px; font-size: 14px; margin-bottom: 16px; }
        .success { background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.3); color: #86efac; padding: 12px 16px; border-radius: 10px; font-size: 14px; margin-bottom: 16px; }
        .trial-badge { text-align: center; margin-top: 20px; color: rgba(255,255,255,0.4); font-size: 13px; }
        .trial-badge strong { color: #6366f1; }
    </style>
</head>
<body>
<div class="container">
    <div class="logo">
        <a href="https://qplus.plus">q<span>plus</span>.plus</a>
        <small>Intelligence artificielle pour courtiers</small>
    </div>
    <div class="tabs">
        <a href="?mode=login" class="tab <?= $mode === 'login' ? 'active' : '' ?>">Connexion</a>
        <a href="?mode=register" class="tab <?= $mode === 'register' ? 'active' : '' ?>">Créer un compte</a>
    </div>
    <?php if ($error): ?>
    <div class="error"><?= htmlspecialchars($error) ?></div>
    <?php endif; ?>
    <?php if ($success): ?>
    <div class="success"><?= htmlspecialchars($success) ?></div>
    <?php endif; ?>
    <?php if ($mode === 'login'): ?>
    <form method="POST">
        <input type="hidden" name="action" value="login">
        <div class="form-group"><label>Email</label><input type="email" name="email" placeholder="vous@exemple.com" required></div>
        <div class="form-group"><label>Mot de passe</label><input type="password" name="password" placeholder="••••••••" required></div>
        <button type="submit" class="btn">Se connecter</button>
    </form>
    <?php else: ?>
    <form method="POST">
        <input type="hidden" name="action" value="register">
        <div class="form-group"><label>Nom complet</label><input type="text" name="name" placeholder="Jean Tremblay" required></div>
        <div class="form-group"><label>Email professionnel</label><input type="email" name="email" placeholder="vous@exemple.com" required></div>
        <div class="form-group"><label>Agence (optionnel)</label><input type="text" name="company" placeholder="RE/MAX, Via Capitale..."></div>
        <div class="form-group"><label>Mot de passe</label><input type="password" name="password" placeholder="Minimum 8 caractères" required></div>
        <button type="submit" class="btn">Créer mon compte gratuit</button>
    </form>
    <div class="trial-badge">✓ <strong>10 crédits gratuits</strong> inclus — Aucune carte requise</div>
    <?php endif; ?>
</div>
</body>
</html>
