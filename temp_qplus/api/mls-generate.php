<?php
header('Content-Type: application/json');
require_once dirname(__DIR__) . '/db.php';

if (!isLoggedIn()) { echo json_encode(['error' => 'Non autorisé']); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { echo json_encode(['error' => 'Méthode non supportée']); exit; }

$input = json_decode(file_get_contents('php://input'), true);
$GEMINI_API_KEY = getConfig('gemini_api_key');
if (!$GEMINI_API_KEY) { echo json_encode(['error' => 'Clé API non configurée']); exit; }

$db = getDB();
$stmt = $db->prepare("SELECT credits FROM brokers WHERE id = ?");
$stmt->execute([$_SESSION['broker_id']]);
$broker = $stmt->fetch();
if ($broker['credits'] < 1) { echo json_encode(['error' => 'Crédits insuffisants']); exit; }

$lengthGuide = ['courte' => '150 words', 'standard' => '250 words', 'detaillee' => '400 words'];
$styleGuide = [
    'professionnel' => 'professional and straightforward',
    'enthousiaste' => 'enthusiastic and engaging, with emotional appeal',
    'luxe' => 'prestigious and luxurious, targeting high-end buyers',
    'familial' => 'warm and family-oriented, highlighting lifestyle',
];

$type = $input['type'] ?? 'maison';
$price = $input['price'] ?? '';
$bed = $input['bedrooms'] ?? '3';
$bath = $input['bathrooms'] ?? '2';
$area = $input['area'] ?? '';
$loc = $input['location'] ?? '';
$features = $input['features'] ?? '';
$style = $styleGuide[$input['style'] ?? 'professionnel'];
$length = $lengthGuide[$input['length'] ?? 'standard'];

$prompt = "You are a professional Quebec real estate copywriter. Generate TWO property descriptions (French and English) for an MLS listing.

Property details:
- Type: $type
- Price: $price
- Bedrooms: $bed
- Bathrooms: $bath
- Area: $area sq ft
- Location: $loc
- Key features: $features

Requirements:
- Style: $style
- Length: approximately $length each
- French description must be in proper Quebecois real estate style
- English description must be natural Canadian real estate language
- Highlight the most appealing features
- Create desire and urgency without being pushy
- Optimize for MLS search terms

Return EXACTLY this JSON format (no other text):
{\"fr\": \"[French description here]\", \"en\": \"[English description here]\"}";

$body = json_encode([
    'contents' => [['parts' => [['text' => $prompt]]]],
    'generationConfig' => ['temperature' => 0.7, 'maxOutputTokens' => 1024]
]);

$url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY";
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

if (!$response || $httpCode !== 200) {
    echo json_encode(['error' => "Erreur API ($httpCode)"]); exit;
}

$data = json_decode($response, true);
$text = $data['candidates'][0]['content']['parts'][0]['text'] ?? '';

// Parse JSON from response — handle markdown code blocks
$text = preg_replace('/```json\s*/', '', $text);
$text = preg_replace('/```\s*/', '', $text);
$text = trim($text);

$parsed = json_decode($text, true);
if (!$parsed || !isset($parsed['fr'])) {
    preg_match('/\{.*"fr"\s*:.*"en"\s*:.*\}/s', $text, $matches);
    if ($matches) $parsed = json_decode($matches[0], true);
}

if (!$parsed || !isset($parsed['fr'])) {
    echo json_encode(['error' => 'Réponse invalide de Gemini. Réessayez.']); exit;
}

$db->prepare("UPDATE brokers SET credits = credits - 1 WHERE id = ?")->execute([$_SESSION['broker_id']]);
$db->prepare("INSERT INTO usage_log (broker_id, action, credits_used) VALUES (?, 'mls_generate', 1)")->execute([$_SESSION['broker_id']]);
$stmt = $db->prepare("SELECT credits FROM brokers WHERE id = ?");
$stmt->execute([$_SESSION['broker_id']]);
$newCredits = $stmt->fetch()['credits'];

echo json_encode([
    'success' => true,
    'fr' => $parsed['fr'],
    'en' => $parsed['en'] ?? '',
    'credits_remaining' => $newCredits
]);
