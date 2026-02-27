<?php
require_once __DIR__ . '/image-edit-models.php';

function assertTrue($cond, $msg) {
    if (!$cond) {
        fwrite(STDERR, "FAIL: $msg\n");
        exit(1);
    }
}

$cases = [
    'default' => resolveImageEditModels(),
    'blocked_requested_pro' => resolveImageEditModels('gemini-2.5-pro'),
    'blocked_requested_preview' => resolveImageEditModels('gemini-2.0-flash-preview-image-generation'),
    'allowed_requested_primary' => resolveImageEditModels('gemini-2.5-flash-image'),
];

foreach ($cases as $name => $resolved) {
    assertTrue($resolved['primary'] === 'gemini-2.5-flash-image', "$name primary must be gemini-2.5-flash-image");
    assertTrue(isset($resolved['models'][0]) && $resolved['models'][0] === 'gemini-2.5-flash-image', "$name first model must be forced primary");
    assertTrue(!in_array('gemini-2.5-pro', $resolved['models'], true), "$name must not route gemini-2.5-pro");
    assertTrue(!in_array('gemini-2.0-flash-preview-image-generation', $resolved['models'], true), "$name must not route dead preview model");
}

assertTrue(
    count($cases['default']['models']) >= 1 && ($cases['default']['fallback'] === null || $cases['default']['models'][1] === $cases['default']['fallback']),
    'default fallback ordering must be deterministic'
);

echo json_encode([
    'ok' => true,
    'cases' => $cases,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;

