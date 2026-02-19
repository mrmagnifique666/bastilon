<?php
header('Content-Type: application/json');
require_once dirname(__DIR__) . '/db.php';

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

// Resize image if too large (> 3MB causes issues with Gemini)
if (strlen($rawImage) > 3 * 1024 * 1024) {
    $img = @imagecreatefromstring($rawImage);
    if ($img) {
        $w = imagesx($img); $h = imagesy($img);
        $scale = sqrt((3 * 1024 * 1024) / strlen($rawImage));
        $nw = (int)($w * $scale); $nh = (int)($h * $scale);
        $resized = imagecreatetruecolor($nw, $nh);
        imagecopyresampled($resized, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
        ob_start(); imagejpeg($resized, null, 85); $rawImage = ob_get_clean();
        imagedestroy($img); imagedestroy($resized);
        $mimeType = 'image/jpeg';
    }
}

$imageData = base64_encode($rawImage);

// --- Helper: Call Gemini image generation model ---
function callGeminiImage($prompt, $mimeType, $imageData, $apiKey, $preferFlash25 = false) {
    $models = $preferFlash25
        ? ['gemini-2.5-flash-image', 'gemini-2.0-flash-exp-image-generation']
        : ['gemini-2.0-flash-exp-image-generation'];

    foreach ($models as $model) {
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
        curl_close($ch);

        if ($response && $httpCode === 200) {
            $data = json_decode($response, true);
            foreach (($data['candidates'][0]['content']['parts'] ?? []) as $part) {
                if (isset($part['inlineData']['data'])) {
                    return ['success' => true, 'data' => $part['inlineData']['data']];
                }
            }
        }

        $errData = json_decode($response, true);
        $lastError = $errData['error']['message'] ?? "HTTP $httpCode";
    }

    return ['success' => false, 'error' => $lastError ?? 'Unknown error'];
}

// --- Helper: Call Gemini text model for analysis ---
function callGeminiText($prompt, $mimeType, $imageData, $apiKey) {
    $body = json_encode([
        'contents' => [[
            'parts' => [
                ['text' => $prompt],
                ['inline_data' => ['mime_type' => $mimeType, 'data' => $imageData]]
            ]
        ]],
        'generationConfig' => ['maxOutputTokens' => 1500]
    ]);

    $url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" . $apiKey;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($response && $httpCode === 200) {
        $data = json_decode($response, true);
        return $data['candidates'][0]['content']['parts'][0]['text'] ?? '';
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
        echo json_encode(['error' => "Erreur étape 1 (vidage): " . $step1['error']]);
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
        echo json_encode(['error' => "Erreur étape 2 (staging): " . $step2['error']]);
        exit;
    }

    $imgB64 = $step2['data'];

// ======================================================================
// ÉCLAIRAGE & DECLUTTER: Smart prompt generation + single edit
// ======================================================================
} else {

    // Step 1: Analyze photo to generate specific prompt
    $analysisPrompts = [
        'eclairage' => 'You are a professional real estate photo analyst. Analyze this photo and describe in detail:
1. Current lighting issues (dark areas, color temperature, shadows, overexposed spots)
2. What the ideal lighting should look like for a luxury real estate listing
3. Specific corrections needed (e.g. "the left corner is very dark", "yellowish tint from artificial light")
Return ONLY a detailed editing prompt (no intro, no explanation) that tells an image editor exactly how to fix the lighting. Be extremely specific about locations and issues in the photo. Start with "You are a professional real estate photo editor."',

        'declutter' => 'You are a professional real estate photo analyst. Analyze this photo and list EVERY object that should be removed for a clean real estate listing. Be extremely specific:
1. Name each object precisely (e.g. "Amazon shipping box on right side of desk", "white coffee mug on floor near chair", "stack of papers on left corner")
2. Describe its location in the photo
3. What the area should look like after removal
4. Also describe the current lighting issues and how to dramatically improve them (make bright, warm, golden hour sunlight)
Return ONLY a detailed editing prompt (no intro, no explanation) that tells an image editor exactly which objects to remove, what to replace them with, AND how to dramatically improve the lighting to professional real estate photography quality. Start with "You are a professional real estate photo editor."',
    ];

    $analysisPrompt = $analysisPrompts[$option] ?? $analysisPrompts['eclairage'];
    if ($custom) $analysisPrompt .= "\n\nUser's additional instructions (MUST follow these): " . $custom;

    $generatedPrompt = callGeminiText($analysisPrompt, $mimeType, $imageData, $GEMINI_API_KEY);

    // Use AI-generated prompt if good, otherwise fallback
    if (strlen($generatedPrompt) > 100) {
        $prompt = $generatedPrompt;
    } else {
        $fallbackPrompts = [
            'eclairage' => 'You are a professional real estate photo editor. DRAMATICALLY enhance the lighting of this real estate photo. Transform dark, yellowish lighting into BRIGHT natural daylight. The room should look like it has large windows letting in warm sunlight on a beautiful day. Walls should be uniformly bright — no dark shadows in corners. Floor should have a warm, rich glow with natural light reflections. Overall brightness at least 2x the original — professional real estate photography quality. Color temperature: warm white like golden hour sunlight. Every corner should be well-lit and inviting. Fix dark shadows, boost natural light, enhance colors to look vibrant but realistic. Keep all architectural elements, furniture, and layout exactly the same — only improve the lighting and color quality.',
            'declutter' => 'You are a professional real estate photo editor. Carefully analyze this photo and remove EVERY item that looks messy, personal, or out of place. This includes: boxes, packages, papers, documents, loose cables, bags, cups, mugs, cleaning items, toys, clutter on surfaces. Replace removed items with clean surfaces. The property should look pristine, organized, and move-in ready. Keep all permanent architectural features, built-in furniture, and landscaping. ALSO dramatically improve the lighting: transform dark or yellowish lighting into bright natural daylight, like golden hour sunlight. Walls should be uniformly bright, no dark shadows in corners. Professional real estate photography quality — bright, warm, inviting.',
        ];
        $prompt = $fallbackPrompts[$option] ?? $fallbackPrompts['eclairage'];
        if ($custom) $prompt .= " Additional instructions: " . $custom;
    }

    $result = callGeminiImage($prompt, $mimeType, $imageData, $GEMINI_API_KEY, true);

    if (!$result['success']) {
        echo json_encode(['error' => "Erreur Gemini: " . $result['error']]);
        exit;
    }

    $imgB64 = $result['data'];
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
