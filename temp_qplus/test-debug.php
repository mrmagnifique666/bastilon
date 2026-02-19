<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

echo "Step 1: PHP works<br>";

require_once 'db.php';
echo "Step 2: db.php loaded<br>";

if (!isLoggedIn()) {
    echo "Step 3: Not logged in - would redirect<br>";
} else {
    echo "Step 3: Logged in as broker " . $_SESSION['broker_id'] . "<br>";

    $db = getDB();
    echo "Step 4: DB connected<br>";

    $stmt = $db->prepare("SELECT credits FROM brokers WHERE id = ?");
    $stmt->execute([$_SESSION['broker_id']]);
    $broker = $stmt->fetch(PDO::FETCH_ASSOC);
    $credits = $broker['credits'];
    echo "Step 5: Credits = $credits<br>";
}

echo "Step 6: All good - no fatal error<br>";
