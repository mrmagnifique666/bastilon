<?php

function getImageEditModelAllowlist() {
    return [
        'gemini-2.5-flash-image',
        'gemini-2.0-flash-exp-image-generation',
    ];
}

function getImageEditModelBlockedList() {
    return [
        'gemini-2.5-pro',
        'gemini-2.0-flash-preview-image-generation',
    ];
}

function resolveImageEditModels($requestedModels = null) {
    $requested = [];
    if (is_string($requestedModels) && $requestedModels !== '') {
        $requested = [$requestedModels];
    } elseif (is_array($requestedModels)) {
        foreach ($requestedModels as $model) {
            if (is_string($model) && $model !== '') $requested[] = $model;
        }
    }

    $primary = 'gemini-2.5-flash-image';
    $allowlist = array_values(array_unique(getImageEditModelAllowlist()));
    $blocked = getImageEditModelBlockedList();

    // Defensive filter so removed/blocked models can never be routed.
    $allowlist = array_values(array_filter($allowlist, function ($model) use ($blocked) {
        return !in_array($model, $blocked, true);
    }));

    if (!in_array($primary, $allowlist, true)) {
        array_unshift($allowlist, $primary);
        $allowlist = array_values(array_unique($allowlist));
    }

    $fallback = null;
    foreach ($allowlist as $model) {
        if ($model !== $primary) {
            $fallback = $model;
            break;
        }
    }

    $models = [$primary];
    if ($fallback !== null) $models[] = $fallback;

    return [
        'models' => $models,
        'primary' => $primary,
        'fallback' => $fallback,
        'allowlist' => $allowlist,
        'requested' => $requested,
        'blocked_requested' => array_values(array_filter($requested, function ($model) use ($blocked) {
            return in_array($model, $blocked, true);
        })),
        'forced_primary' => true,
    ];
}

