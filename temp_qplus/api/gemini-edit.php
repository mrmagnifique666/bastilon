<?php
header('Content-Type: application/json');
require_once dirname(__DIR__) . '/db.php';
require_once __DIR__ . '/image-edit-models.php';

if (!isLoggedIn()) { echo json_encode(['error' => 'Non autorisé']); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { echo json_encode(['error' => 'Méthode non supportée']); exit; }

$GEMINI_API_KEY = getConfig('gemini_api_key');
if (!$GEMINI_API_KEY) { echo json_encode(['error' => 'Clé API non configurée']); exit; }

$option = $_POST['option'] ?? 'eclairage';
$room = $_POST['room'] ?? 'salon';
$custom = trim($_POST['custom'] ?? '');

if (!isset($_FILES['photo']) || $_FILES['photo']['error'] !== UPLOAD_ERR_OK) {
    echo json_encode(['error' => 'Aucun fichier reçu']);
    exit;
}

$file = $_FILES['photo'];
if ($file['size'] > 10 * 1024 * 1024) {
    echo json_encode(['error' => 'Fichier trop grand (max 10MB)']);
    exit;
}

$db = getDB();
$stmt = $db->prepare("SELECT credits FROM brokers WHERE id = ?");
$stmt->execute([$_SESSION['broker_id']]);
$broker = $stmt->fetch();
if ($broker['credits'] < 1) { echo json_encode(['error' => 'Crédits insuffisants']); exit; }

// Room labels in French for prompt
$roomLabels = [
    'salon' => 'living room (salon)',
    'cuisine' => 'kitchen (cuisine)',
    'chambre_principale' => 'master bedroom (chambre principale)',
    'chambre_secondaire' => 'secondary bedroom (chambre secondaire)',
    'salle_de_bain' => 'bathroom (salle de bain)',
    'salle_a_manger' => 'dining room (salle à manger)',
    'bureau' => 'home office / bureau',
    'sous_sol' => 'basement / recreation room (sous-sol)',
    'exterieur' => 'patio/terrace/exterior (extérieur)',
];
$roomLabel = $roomLabels[$room] ?? 'room';

// --- PREPARE IMAGE DATA ---
$mimeType = $file['type'] ?: 'image/jpeg';
$rawImage = file_get_contents($file['tmp_name']);

// Resize image — keep under 1.5MB for reliable Gemini edits
$maxBytes = 1536 * 1024; // 1.5MB
if (strlen($rawImage) > $maxBytes) {
    $img = @imagecreatefromstring($rawImage);
    if ($img) {
        $w = imagesx($img); $h = imagesy($img);
        $scale = sqrt($maxBytes / strlen($rawImage));
        $nw = (int)($w * $scale); $nh = (int)($h * $scale);
        $resized = imagecreatetruecolor($nw, $nh);
        imagecopyresampled($resized, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
        ob_start(); imagejpeg($resized, null, 85); $rawImage = ob_get_clean();
        imagedestroy($img); imagedestroy($resized);
        $mimeType = 'image/jpeg';
    }
}

$imageData = base64_encode($rawImage);

// --- Logging helper ---
function geminiLog($msg) {
    $logFile = dirname(__DIR__) . '/data/gemini-debug.log';
    $ts = date('Y-m-d H:i:s');
    @file_put_contents($logFile, "[$ts] $msg\n", FILE_APPEND);
}

function buildImageEditFailurePayload($message, $result = null, $extra = []) {
    $payload = ['success' => false, 'error' => $message];
    if (is_array($result)) {
        $payload['fallback'] = [
            'attempted' => (bool)($result['fallback_attempted'] ?? false),
            'attempts' => $result['attempts'] ?? [],
            'routing' => $result['routing'] ?? null,
        ];
        $payload['provider_error'] = [
            'code' => $result['provider_error_code'] ?? null,
            'message' => $result['provider_error_message'] ?? null,
            'status' => $result['provider_error_status'] ?? null,
            'raw' => $result['provider_error_raw'] ?? null,
        ];
    }
    return array_merge($payload, $extra);
}

// --- Helper: Call Gemini image generation model ---
function callGeminiImage($prompt, $mimeType, $imageData, $apiKey, $requestedModels = null) {
    $routing = resolveImageEditModels($requestedModels);
    $models = $routing['models'];
    $lastError = 'Unknown error';
    $lastProviderCode = null;
    $lastProviderMessage = null;
    $lastProviderStatus = null;
    $lastProviderRaw = null;
    $attempts = [];

    if (!empty($routing['blocked_requested'])) {
        geminiLog("Image edit routing override: blocked requested models=" . implode(',', $routing['blocked_requested']) . " forced_primary=" . $routing['primary']);
    }
    geminiLog("Image edit routing: primary={$routing['primary']}" . ($routing['fallback'] ? " fallback={$routing['fallback']}" : " fallback=none"));

    foreach ($models as $model) {
        geminiLog("Trying model: $model (image size: " . strlen($imageData) . " chars b64)");
        $attempt = [
            'model' => $model,
            'http_code' => null,
            'provider_error_code' => null,
            'provider_error_message' => null,
            'provider_error_status' => null,
            'finish_reason' => null,
            'curl_error' => null,
            'outcome' => 'unknown',
        ];

        $requestBody = json_encode([
            'contents' => [[
                'parts' => [
                    ['text' => $prompt],
                    ['inline_data' => ['mime_type' => $mimeType, 'data' => $imageData]]
                ]
            ]],
            'generationConfig' => ['responseModalities' => ['TEXT', 'IMAGE']]
        ]);

        $url = "https://generativelanguage.googleapis.com/v1beta/models/{$model}:generateContent?key=" . $apiKey;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $requestBody,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);
        $attempt['http_code'] = $httpCode;

        geminiLog("Model $model: HTTP $httpCode" . ($curlErr ? " curl_error=$curlErr" : ""));

        if ($curlErr) {
            $lastError = "Erreur reseau: $curlErr";
            $attempt['curl_error'] = $curlErr;
            $attempt['outcome'] = 'curl_error';
            $attempts[] = $attempt;
            continue;
        }

        if ($response && $httpCode === 200) {
            $data = json_decode($response, true);
            $finishReason = $data['candidates'][0]['finishReason'] ?? 'UNKNOWN';
            $attempt['finish_reason'] = $finishReason;
            geminiLog("Model $model: finishReason=$finishReason");

            if ($finishReason === 'SAFETY' || $finishReason === 'RECITATION' || $finishReason === 'OTHER') {
                $lastError = "Gemini a refuse la modification (raison: $finishReason). Essayez avec une autre photo.";
                geminiLog("BLOCKED by safety: $finishReason");
                $attempt['outcome'] = 'blocked_' . strtolower($finishReason);
                $attempts[] = $attempt;
                continue;
            }

            $textParts = [];
            foreach (($data['candidates'][0]['content']['parts'] ?? []) as $part) {
                if (isset($part['inlineData']['data'])) {
                    geminiLog("Model $model: SUCCESS - image returned");
                    $attempt['outcome'] = 'success';
                    $attempts[] = $attempt;
                    return [
                        'success' => true,
                        'data' => $part['inlineData']['data'],
                        'model' => $model,
                        'routing' => $routing,
                        'attempts' => $attempts,
                        'fallback_attempted' => count($attempts) > 1,
                    ];
                }
                if (isset($part['text'])) {
                    $textParts[] = $part['text'];
                }
            }

            if (!empty($textParts)) {
                $textPreview = substr(implode(' ', $textParts), 0, 200);
                geminiLog("Model $model: 200 OK but NO IMAGE. Text: $textPreview");
                $lastError = "Le modele n'a pas genere d'image. Il a repondu: " . substr($textPreview, 0, 100);
                $attempt['outcome'] = 'text_only';
            } else {
                geminiLog("Model $model: 200 OK but empty response");
                $lastError = "Reponse vide du modele $model";
                $attempt['outcome'] = 'empty_response';
            }
            $attempts[] = $attempt;
        } else {
            $errData = json_decode($response, true);
            $lastProviderCode = $errData['error']['code'] ?? null;
            $lastProviderMessage = $errData['error']['message'] ?? null;
            $lastProviderStatus = $errData['error']['status'] ?? null;
            $lastProviderRaw = $errData['error'] ?? null;
            $lastError = $lastProviderMessage ?? "HTTP $httpCode";
            $attempt['provider_error_code'] = $lastProviderCode;
            $attempt['provider_error_message'] = $lastProviderMessage;
            $attempt['provider_error_status'] = $lastProviderStatus;
            $attempt['outcome'] = 'provider_error';
            $attempts[] = $attempt;
            geminiLog("Model $model: ERROR - $lastError");
        }
    }

    geminiLog("ALL MODELS FAILED. Last error: $lastError");
    return [
        'success' => false,
        'error' => $lastError,
        'provider_error_code' => $lastProviderCode,
        'provider_error_message' => $lastProviderMessage,
        'provider_error_status' => $lastProviderStatus,
        'provider_error_raw' => $lastProviderRaw,
        'routing' => $routing,
        'attempts' => $attempts,
        'fallback_attempted' => count($attempts) > 1,
    ];
}


// --- Helper: Call Gemini PREMIUM text model for analysis (best vision) ---
function callGeminiText($prompt, $mimeType, $imageData, $apiKey) {
    // Model priority: best vision first, fallback to faster models
    $models = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];

    foreach ($models as $model) {
        $body = json_encode([
            'contents' => [[
                'parts' => [
                    ['text' => $prompt],
                    ['inline_data' => ['mime_type' => $mimeType, 'data' => $imageData]]
                ]
            ]],
            'generationConfig' => ['maxOutputTokens' => 4096, 'temperature' => 0.1]
        ]);

        $url = "https://generativelanguage.googleapis.com/v1beta/models/{$model}:generateContent?key=" . $apiKey;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 90,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($response && $httpCode === 200) {
            $data = json_decode($response, true);
            $text = $data['candidates'][0]['content']['parts'][0]['text'] ?? '';
            if (!empty($text)) {
                geminiLog("callGeminiText: $model SUCCESS (" . strlen($text) . " chars)");
                return $text;
            }
        }
        geminiLog("callGeminiText: $model FAILED (HTTP $httpCode), trying next...");
    }
    return '';
}

// ======================================================================
// HOME STAGING: 2-step process (empty room → stage)
// ======================================================================
if ($option === 'homestaging') {

    // STEP 1: Empty the room completely + dramatically improve lighting
    $emptyPrompt = 'PHOTO EDITING TASK — NOT generation. Edit THIS specific photo. Two goals: (1) remove all objects, (2) dramatically improve lighting. '
        . 'REMOVAL — Remove all furniture and objects from this room. '
        . 'REMOVE (erase and fill with wall/floor behind): all furniture, shelves, desks, chairs, decorations, wall art, posters, frames, boxes, papers, cables, electronics, plants, lamps, cups, bags, ALL objects. Leave NOTHING except the room structure. '
        . 'KEEP exactly as-is: walls (same color/texture), floor (same material/pattern), baseboards, ceiling light fixtures, door frames, electrical outlets. '
        . 'CRITICAL: Maintain EXACT same room proportions and dimensions. Maintain EXACT same camera angle and lens perspective. Where furniture was removed, show the wall/floor that would be behind it. '
        . 'LIGHTING ENHANCEMENT (CRITICAL — make this dramatic): '
        . 'Transform dark, yellowish lighting into BRIGHT natural daylight. '
        . 'The room should look like it has large windows letting in warm sunlight on a beautiful day. '
        . 'Walls should be uniformly bright, clean — no dark shadows in corners. '
        . 'Floor should have a warm, rich glow with natural light reflections. '
        . 'Overall brightness at least 2x the original — think professional real estate photography. '
        . 'Color temperature: warm white (not cold), like golden hour sunlight. '
        . 'Every corner of the room should be well-lit and inviting.';

    if ($custom) $emptyPrompt .= " Additional context: " . $custom;

    $step1 = callGeminiImage($emptyPrompt, $mimeType, $imageData, $GEMINI_API_KEY, true);

    if (!$step1['success']) {
        echo json_encode(buildImageEditFailurePayload(
            "Erreur etape 1 (vidage): " . $step1['error'],
            $step1,
            ['step' => 'homestaging_empty']
        ));
        exit;
    }

    // STEP 2: Stage the empty room
    $stagePrompt = 'You are a professional virtual home stager for luxury real estate listings. '
        . 'This is a photo of an empty ' . $roomLabel . '. Stage it for a high-end MLS/Centris listing. '
        . 'ADD appropriate furniture and decor for a ' . $roomLabel . ': ';

    // Room-specific staging instructions
    $roomStaging = [
        'salon' => 'Add a modern L-shaped sectional sofa (light gray), a coffee table (walnut), a TV console, 2 accent pillows, a large area rug, one floor plant, one abstract art piece on the wall, a floor lamp. Style: modern-contemporary, warm tones.',
        'cuisine' => 'Add a kitchen island with 2-3 bar stools, fresh fruit bowl, small herb plant, pendant lights over island, modern accessories. Keep appliances if present. Style: modern, clean, functional.',
        'chambre_principale' => 'Add a king-size bed with premium white/gray bedding, 2 nightstands with lamps, a dresser, one large art piece above bed, 2 accent pillows, a soft area rug. Style: luxury hotel, serene.',
        'chambre_secondaire' => 'Add a queen bed with neutral bedding, one nightstand with lamp, a small desk with chair, one art piece. Style: clean, versatile guest room.',
        'salle_de_bain' => 'Add fresh white towels rolled neatly, a small plant, soap dispenser, candle. Keep all fixtures. Style: spa-like, pristine.',
        'salle_a_manger' => 'Add a dining table (seats 6-8, dark walnut), matching chairs, a centerpiece (candles or small plant), pendant light above table, a sideboard/buffet. Style: elegant dinner party ready.',
        'bureau' => 'Add a modern executive desk (dark walnut), premium leather chair, a tall bookshelf with organized neutral books and 2-3 decor items, one green plant, one abstract art piece, a laptop, desk lamp, and area rug. Style: executive home office.',
        'sous_sol' => 'Add a large sectional sofa, entertainment center, coffee table, area rug, floor lamp, accent pillows. Style: cozy recreation room, family-friendly.',
        'exterieur' => 'Add outdoor furniture set (table + 4 chairs), potted plants, string lights, outdoor rug. Style: summer entertaining ready.',
    ];

    $stagePrompt .= ($roomStaging[$room] ?? $roomStaging['salon']);
    $stagePrompt .= ' LIGHTING (CRITICAL — maintain and enhance): Keep the bright, warm natural daylight feel. '
        . 'Furniture should have natural light reflections and soft shadows consistent with the room lighting. '
        . 'Everything should look bathed in beautiful golden hour sunlight. '
        . 'Professional real estate photography quality — bright, warm, inviting. '
        . 'Keep the SAME room structure, walls, floor, ceiling. Keep the SAME camera angle. Photorealistic quality, not AI-looking. No personal items, no clutter — luxury staging only.';

    if ($custom) $stagePrompt .= " User instructions: " . $custom;

    // Use the empty room image as input for staging
    $step2 = callGeminiImage($stagePrompt, 'image/jpeg', $step1['data'], $GEMINI_API_KEY, true);

    if (!$step2['success']) {
        echo json_encode(buildImageEditFailurePayload(
            "Erreur etape 2 (staging): " . $step2['error'],
            $step2,
            ['step' => 'homestaging_stage']
        ));
        exit;
    }

    $imgB64 = $step2['data'];

// ======================================================================
// ÉCLAIRAGE & DECLUTTER: Smart prompt generation + single edit
// ======================================================================
} else {

    // ── PASS 1: PREMIUM Vision analysis — exhaustive room scan ──
    if ($option === 'declutter') {
        $analysisPrompt = 'You are a professional real estate photographer performing a pre-edit analysis for virtual decluttering. '
            . 'Perform an EXHAUSTIVE scan of this photo. For EVERY object that must be removed for a professional MLS/Centris listing, provide: '
            . "\n\nFORMAT FOR EACH ITEM:"
            . "\n[#] OBJECT: [exact name] | LOCATION: [quadrant: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right] | SURFACE: [what it sits on: floor, desk, wall, shelf, counter] | SIZE: [small/medium/large] | COLOR: [primary color + material] | BEHIND: [what is behind/under it — wall color, floor type, surface texture to reveal]"
            . "\n\nCATEGORIES TO SCAN (check ALL):"
            . "\n- FURNITURE: cheap/personal items not worthy of staging (folding chairs, plastic bins, old shelves)"
            . "\n- ELECTRONICS: monitors, cables, chargers, routers, power strips, game consoles, speakers, headphones"
            . "\n- PAPER: mail stacks, books, magazines, sticky notes, calendars, receipts, notebooks"
            . "\n- PERSONAL: family photos, trophies, religious items, children art, diplomas, memorabilia"
            . "\n- CLUTTER: boxes (cardboard, plastic), bags (shopping, trash, backpacks), piles of anything"
            . "\n- CLOTHING: hanging items, shoes, laundry baskets, coats, hats"
            . "\n- KITCHEN: dirty dishes, food, small appliances on counter, dish rack, sponge"
            . "\n- BATHROOM: toiletries, messy towels, toothbrushes, shampoo bottles"
            . "\n- DECORATIONS: cheap posters, non-professional wall art, fridge magnets, stickers"
            . "\n- FLOOR: shoes, pet toys, rugs (if cheap/dirty), door mats, cables running on floor"
            . "\n\nALSO DESCRIBE THE ROOM STRUCTURE (separate section at the end):"
            . "\n- WALLS: exact color (e.g. 'off-white eggshell', 'light beige'), texture (smooth, textured), condition"
            . "\n- FLOOR: material (hardwood/carpet/tile/laminate), color, pattern, condition"
            . "\n- CEILING: color, light fixtures, height estimate"
            . "\n- WINDOWS: location, size, light direction, curtains/blinds"
            . "\n- DOORS: location, color, open/closed"
            . "\n- ROOM SHAPE: proportions (narrow/square/L-shaped), approximate dimensions"
            . "\n\nBe EXHAUSTIVE. Every missed item = that item stays in the final photo. Max 30 items. Numbered list.";
    } else {
        $analysisPrompt = 'You are a professional real estate photography lighting expert performing a comprehensive lighting analysis. '
            . 'Analyze EVERY lighting issue in this photo with extreme precision. '
            . "\n\nFORMAT FOR EACH ISSUE:"
            . "\n[#] ISSUE: [type] | LOCATION: [quadrant] | SEVERITY: [1-5, 5=worst] | DESCRIPTION: [detailed] | TARGET: [what it should look like after fix]"
            . "\n\nISSUE TYPES TO CHECK:"
            . "\n- DARK ZONES: corners, under furniture, behind objects, ceiling edges, floor under tables"
            . "\n- COLOR CAST: yellow/orange from tungsten, green from fluorescent, blue from screens, mixed temps"
            . "\n- HARSH SHADOWS: directional shadows from single light source, multiple conflicting shadow angles"
            . "\n- UNDEREXPOSURE: areas too dark to see detail, lost texture/color"
            . "\n- OVEREXPOSURE: blown out windows, hot spots from direct bulbs"
            . "\n- UNEVEN LIGHTING: one side significantly brighter than other"
            . "\n- ARTIFICIAL LOOK: visible fixture glare, non-natural light patterns, fluorescent flicker look"
            . "\n\nGLOBAL ANALYSIS (separate section):"
            . "\n- CURRENT LIGHT SOURCES: list each (window, lamp, overhead, etc.), position, color temp, intensity"
            . "\n- OVERALL EXPOSURE: under/proper/over, EV estimate"
            . "\n- CURRENT COLOR TEMP: estimated Kelvin (2700K warm → 6500K cool)"
            . "\n- TARGET COLOR TEMP: 5000-5500K clean daylight"
            . "\n- WALLS: current brightness % vs target (e.g. 'at 40%, need 85%')"
            . "\n- FLOOR: current brightness, reflectivity"
            . "\n- DARKEST AREA: exact location and how dark (0-100%)"
            . "\n- BRIGHTEST AREA: exact location"
            . "\n\nBe EXHAUSTIVE. Every shadow, every color issue, every dark corner. Max 20 issues. Numbered list.";
    }

    $analysisResult = callGeminiText($analysisPrompt, $mimeType, $imageData, $GEMINI_API_KEY);
    geminiLog("PASS 1 analysis (" . strlen($analysisResult) . " chars): " . substr($analysisResult, 0, 300));

    // ── PASS 2: Build MAXIMUM-DETAIL targeted prompt from analysis ──
    if ($option === 'declutter') {
        $itemList = !empty($analysisResult)
            ? "=== DETAILED ROOM ANALYSIS (from vision AI) ===\n" . $analysisResult . "\n=== END ANALYSIS ==="
            : "ITEMS TO REMOVE: all clutter, boxes, cables, personal objects, papers, cups, bags, clothes, decorations on any surface throughout the room";

        $prompt = 'You are a professional real estate photo retoucher preparing this image for an MLS/Centris listing. '
            . 'This is a PHOTO EDITING task — you MUST modify this image. Returning it unchanged is NOT acceptable. '
            . "\n\n" . $itemList
            . "\n\n=== EDITING INSTRUCTIONS (follow ALL steps) ==="
            . "\n\nSTEP 1 — OBJECT REMOVAL:"
            . "\nFor EVERY item listed in the analysis above, perform complete removal:"
            . "\n- Erase the object entirely — no traces, no ghost outlines, no smudging"
            . "\n- Fill the revealed area with the EXACT wall/floor/surface texture that would logically be behind it"
            . "\n- Match the surrounding color, grain, pattern, and perspective precisely"
            . "\n- Reconstruct any baseboards, moldings, or architectural lines that were hidden behind objects"
            . "\n- Ensure the floor/wall texture flows naturally through the area — no visible seams or patches"
            . "\n- Remove ALL cables, power strips, and wire traces along walls and floors"
            . "\n\nSTEP 2 — SURFACE CLEANUP:"
            . "\n- All counters, desks, tables: completely bare and clean"
            . "\n- All shelves: empty or with minimal tasteful staging items only"
            . "\n- Floor: spotless, no dust, no marks, consistent finish throughout"
            . "\n- Walls: clean, no nail holes, no tape marks, no scuff marks"
            . "\n\nSTEP 3 — LIGHTING ENHANCEMENT (apply AFTER cleanup):"
            . "\n- Increase overall brightness by 2.5x — the room must feel sun-drenched"
            . "\n- Replace ALL yellow/orange artificial lighting with clean 5200K daylight white"
            . "\n- Eliminate every shadow in every corner — fill with ambient light"
            . "\n- Add subtle natural light glow from window direction"
            . "\n- Walls should appear uniformly bright (85%+ brightness)"
            . "\n- Floor should have a warm, natural light reflection"
            . "\n\nSTEP 4 — FINAL QUALITY CHECK:"
            . "\n- Maintain exact room proportions, camera angle, and lens perspective"
            . "\n- Maintain exact wall colors (just brighter)"
            . "\n- Maintain exact floor material and pattern"
            . "\n- No AI artifacts, no warped lines, no floating objects"
            . "\n- The result must look like a professional real estate photographer shot this room when it was perfectly clean and staged"
            . "\n\nThe DIFFERENCE between input and output MUST be dramatic and immediately obvious.";
    } else {
        $lightingList = !empty($analysisResult)
            ? "=== DETAILED LIGHTING ANALYSIS (from vision AI) ===\n" . $analysisResult . "\n=== END ANALYSIS ==="
            : "LIGHTING PROBLEMS: dark corners throughout, yellow/orange artificial light, underexposed areas, harsh shadows, uneven illumination, low overall brightness";

        $prompt = 'You are a professional real estate photography post-production specialist. '
            . 'This is a PHOTO EDITING task — you MUST dramatically improve the lighting of this image. Returning it unchanged is NOT acceptable. '
            . "\n\n" . $lightingList
            . "\n\n=== LIGHTING CORRECTION INSTRUCTIONS (follow ALL steps) ==="
            . "\n\nSTEP 1 — SHADOW ELIMINATION:"
            . "\nFor EVERY dark zone and shadow identified in the analysis:"
            . "\n- Fill with soft, diffused ambient light matching the surrounding surfaces"
            . "\n- No corner should be darker than 70% of the brightest wall area"
            . "\n- Under-furniture shadows: soften to barely visible"
            . "\n- Ceiling-wall junction shadows: eliminate completely"
            . "\n- Behind-object shadows: fill with natural-looking ambient light"
            . "\n\nSTEP 2 — COLOR TEMPERATURE CORRECTION:"
            . "\n- Target: 5000-5500K clean, warm daylight throughout"
            . "\n- Remove ALL yellow/orange tungsten color cast"
            . "\n- Remove ALL green fluorescent cast"
            . "\n- White walls must appear TRUE WHITE with slight warm tint"
            . "\n- Wood surfaces should show their natural rich warm color, not orange-shifted"
            . "\n- Neutral surfaces (gray, beige) should be true-to-color, not shifted"
            . "\n\nSTEP 3 — BRIGHTNESS BOOST:"
            . "\n- Overall brightness: increase by 3x minimum"
            . "\n- Walls: raise to 85-95% brightness (uniformly)"
            . "\n- Ceiling: raise to 90%+ brightness"
            . "\n- Floor: raise to 70-80% with natural light reflections"
            . "\n- Add subtle natural window light with soft directional glow"
            . "\n- Every surface should feel sun-kissed — like a bright afternoon"
            . "\n\nSTEP 4 — PROFESSIONAL FINISH:"
            . "\n- Add subtle ambient occlusion for depth (very soft, not dark)"
            . "\n- Light should feel natural and consistent — single dominant source (simulated large window)"
            . "\n- No blown-out spots, no artificial halos around lights"
            . "\n- Maintain exact room structure, furniture positions, and camera angle"
            . "\n- Result must look like HDR real estate photography with professional flash fill"
            . "\n\nThe DIFFERENCE between input and output MUST be dramatic — from dark/moody to bright/inviting luxury listing.";
    }

    if ($custom) $prompt .= "\nADDITIONAL: " . $custom;

    // ── PASS 2 execution: edit with targeted prompt, retry if unchanged ──
    $imgB64 = null;
    for ($attempt = 1; $attempt <= 3; $attempt++) {
        $attemptPrompt = $attempt === 1
            ? $prompt
            : 'RETRY ' . $attempt . ' — PREVIOUS ATTEMPT UNCHANGED. YOU MUST MAKE DRAMATIC CHANGES NOW. ' . $prompt;

        geminiLog("PASS 2 attempt $attempt — prompt length: " . strlen($attemptPrompt));
        $result = callGeminiImage($attemptPrompt, $mimeType, $imageData, $GEMINI_API_KEY, true);

        if (!$result['success']) {
            geminiLog("Attempt $attempt failed: " . $result['error']);
            if ($attempt === 3) {
                echo json_encode(buildImageEditFailurePayload(
                    'Erreur Gemini: ' . $result['error'],
                    $result,
                    ['step' => $option, 'edit_attempt' => $attempt]
                ));
                exit;
            }
            continue;
        }

        $origLen   = strlen($imageData);
        $resultLen = strlen($result['data']);
        $changePct = $origLen > 0 ? abs($origLen - $resultLen) / $origLen : 1;
        geminiLog("Attempt $attempt: size_diff=" . round($changePct * 100, 2) . "%");

        if ($changePct > 0.03 || $attempt === 3) {
            $imgB64 = $result['data'];
            break;
        }
        geminiLog("Attempt $attempt: unchanged (<3% diff), retrying...");
    }

    if ($imgB64 === null) {
        echo json_encode([
            'success' => false,
            'error' => "Le modele a retourne l'image sans modification apres 3 tentatives.",
            'step' => $option,
            'edit_attempts' => 3
        ]);
        exit;
    }
}

// --- SAVE & RESPOND ---
$uploadsDir = dirname(__DIR__) . '/uploads/';
if (!is_dir($uploadsDir)) mkdir($uploadsDir, 0755, true);
$filename = 'edited_' . $_SESSION['broker_id'] . '_' . time() . '.jpg';
file_put_contents($uploadsDir . $filename, base64_decode($imgB64));

// Log & deduct credit
$db->prepare("UPDATE brokers SET credits = credits - 1 WHERE id = ?")->execute([$_SESSION['broker_id']]);
try {
    $db->prepare("INSERT INTO usage_log (broker_id, action, credits_used) VALUES (?, 'photo_edit', 1)")->execute([$_SESSION['broker_id']]);
} catch (Exception $e) {
    $db->prepare("INSERT INTO usage_log (broker_id, action) VALUES (?, 'photo_edit')")->execute([$_SESSION['broker_id']]);
}
try {
    $db->prepare("INSERT INTO uploads (broker_id, filename, original_name, type) VALUES (?, ?, ?, 'photo_edit')")->execute([$_SESSION['broker_id'], $filename, $file['name']]);
} catch (Exception $e) {
    $db->prepare("INSERT INTO uploads (broker_id, filename, original_name) VALUES (?, ?, ?)")->execute([$_SESSION['broker_id'], $filename, $file['name']]);
}

$stmt = $db->prepare("SELECT credits FROM brokers WHERE id = ?");
$stmt->execute([$_SESSION['broker_id']]);
$newCredits = $stmt->fetch()['credits'];

echo json_encode(['success' => true, 'image_url' => 'uploads/' . $filename, 'credits_remaining' => $newCredits]);
