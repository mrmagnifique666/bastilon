<?php
header('Content-Type: application/json');

$results = [
    'php_version' => PHP_VERSION,
    'max_execution_time' => ini_get('max_execution_time'),
    'memory_limit' => ini_get('memory_limit'),
    'upload_max_filesize' => ini_get('upload_max_filesize'),
    'post_max_size' => ini_get('post_max_size'),
    'curl_enabled' => function_exists('curl_init'),
    'gd_enabled' => extension_loaded('gd'),
];

// Test Gemini API key
$configFile = dirname(__DIR__) . '/data/config.json';
if (file_exists($configFile)) {
    $config = json_decode(file_get_contents($configFile), true);
    $apiKey = $config['gemini_api_key'] ?? null;
    $results['api_key_set'] = !empty($apiKey);
    $results['api_key_prefix'] = $apiKey ? substr($apiKey, 0, 10) . '...' : 'MISSING';

    // Quick test: Gemini text model
    if ($apiKey) {
        $ch = curl_init("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" . $apiKey);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode(['contents' => [['parts' => [['text' => 'Say OK']]]]]),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
        ]);
        $resp = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);
        $results['gemini_text_test'] = [
            'http_code' => $httpCode,
            'curl_error' => $curlErr ?: null,
            'response_preview' => substr($resp, 0, 200),
        ];

        // Test image model
        $ch2 = curl_init("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" . $apiKey);
        curl_setopt_array($ch2, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode([
                'contents' => [['parts' => [['text' => 'Generate a small blue square, 100x100px']]]],
                'generationConfig' => ['responseModalities' => ['TEXT', 'IMAGE']]
            ]),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 60,
        ]);
        $resp2 = curl_exec($ch2);
        $httpCode2 = curl_getinfo($ch2, CURLINFO_HTTP_CODE);
        $curlErr2 = curl_error($ch2);
        curl_close($ch2);

        $data2 = json_decode($resp2, true);
        $hasImage = false;
        foreach (($data2['candidates'][0]['content']['parts'] ?? []) as $part) {
            if (isset($part['inlineData']['data'])) $hasImage = true;
        }
        $results['gemini_image_test'] = [
            'http_code' => $httpCode2,
            'curl_error' => $curlErr2 ?: null,
            'returned_image' => $hasImage,
            'response_preview' => substr($resp2, 0, 200),
        ];
    }
} else {
    $results['config_file'] = 'NOT FOUND at ' . $configFile;
}

// Check uploads dir
$uploadsDir = dirname(__DIR__) . '/uploads/';
$results['uploads_dir_exists'] = is_dir($uploadsDir);
$results['uploads_dir_writable'] = is_writable($uploadsDir);

echo json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
