/**
 * Built-in skills: travel.plan, travel.search, travel.packing
 * Travel Planner — multi-destination itinerary generation with budget constraints.
 * Uses Gemini for itinerary planning, web search for pricing.
 */
import { registerSkill, getSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { log } from "../../utils/log.js";

async function askGemini(prompt: string): Promise<string> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY required");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

registerSkill({
  name: "travel.plan",
  description:
    "Generate a complete travel itinerary: flights, hotels, daily activities, budget breakdown. " +
    "Supports multi-destination trips.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      destinations: { type: "string", description: "Comma-separated destinations (e.g. 'Tokyo, Kyoto, Osaka')" },
      dates: { type: "string", description: "Travel dates (e.g. '2026-03-15 to 2026-03-25')" },
      budget: { type: "number", description: "Total budget (in your currency)" },
      currency: { type: "string", description: "Budget currency (default: CAD)" },
      style: { type: "string", description: "Travel style: budget, mid-range, luxury (default: mid-range)" },
      interests: { type: "string", description: "Interests: food, culture, nature, nightlife, shopping (comma-separated)" },
    },
    required: ["destinations", "dates"],
  },
  async execute(args): Promise<string> {
    const destinations = String(args.destinations);
    const dates = String(args.dates);
    const budget = args.budget ? Number(args.budget) : null;
    const currency = String(args.currency || "CAD");
    const style = String(args.style || "mid-range");
    const interests = args.interests ? String(args.interests) : "culture, food";

    const prompt = `Create a detailed travel itinerary in French:

**Destinations**: ${destinations}
**Dates**: ${dates}
**Budget**: ${budget ? `${budget} ${currency}` : "flexible"}
**Style**: ${style}
**Interests**: ${interests}

Include:
1. **Résumé** — overview of the trip
2. **Budget estimé** — breakdown: transport, hébergement, repas, activités
3. **Itinéraire jour par jour**:
   - Matin / Après-midi / Soir activités
   - Restaurants recommandés
   - Transports entre destinations
   - Coût estimé par jour
4. **Conseils pratiques** — visa, météo, apps utiles, phrases locales
5. **Alternatives budget** — si trop cher, options moins chères

Be specific with real restaurant/hotel names and approximate prices in ${currency}.`;

    try {
      const itinerary = await askGemini(prompt);
      return itinerary;
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "travel.search",
  description: "Search for flights, hotels, or activities for a destination.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      type: { type: "string", description: "Search type: flights, hotels, activities" },
      destination: { type: "string", description: "Destination city" },
      dates: { type: "string", description: "Date range" },
      from: { type: "string", description: "Departure city (for flights)" },
    },
    required: ["type", "destination"],
  },
  async execute(args): Promise<string> {
    const searchType = String(args.type);
    const destination = String(args.destination);
    const dates = args.dates ? String(args.dates) : "";
    const from = args.from ? String(args.from) : "Montreal";

    const webSearch = getSkill("web.search");
    if (!webSearch) return "web.search non disponible.";

    const queries: Record<string, string> = {
      flights: `cheap flights ${from} to ${destination} ${dates}`,
      hotels: `best ${destination} hotels ${dates} booking.com`,
      activities: `top things to do ${destination} ${dates}`,
    };

    const query = queries[searchType] || `${searchType} ${destination} ${dates}`;

    try {
      const result = await webSearch.execute({ query });
      return `**Résultats: ${searchType} — ${destination}**\n\n${String(result).slice(0, 3000)}`;
    } catch (err) {
      return `Erreur recherche: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "travel.packing",
  description: "Generate a packing list based on destination, duration, and activities.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      destination: { type: "string", description: "Destination" },
      days: { type: "number", description: "Number of days" },
      activities: { type: "string", description: "Planned activities (comma-separated)" },
      season: { type: "string", description: "Season: summer, winter, spring, fall" },
    },
    required: ["destination", "days"],
  },
  async execute(args): Promise<string> {
    const destination = String(args.destination);
    const days = Number(args.days);
    const activities = args.activities ? String(args.activities) : "";
    const season = args.season ? String(args.season) : "";

    const prompt = `Génère une liste de bagages complète en français pour:
Destination: ${destination}
Durée: ${days} jours
${season ? `Saison: ${season}` : ""}
${activities ? `Activités: ${activities}` : ""}

Organise par catégorie:
- Vêtements (avec quantités)
- Toilette
- Électronique
- Documents
- Divers
- Spécifique à la destination

Utilise des checkboxes (- [ ]) pour chaque item.`;

    try {
      return await askGemini(prompt);
    } catch (err) {
      return `Erreur: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

log.debug("Registered 3 travel.* skills");
