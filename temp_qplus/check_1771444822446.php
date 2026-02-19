<?php
header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store');
echo json_encode([
    'php' => PHP_VERSION,
    'pdo_sqlite' => extension_loaded('pdo_sqlite'),
    'pdo_drivers' => PDO::getAvailableDrivers(),
    'dir_writable' => is_writable(__DIR__),
    'data_dir' => is_dir(__DIR__ . '/data'),
    'time' => date('H:i:s')
]);
