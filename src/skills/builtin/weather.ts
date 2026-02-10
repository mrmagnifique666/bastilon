/**
 * Built-in skill: weather.current
 * Open-Meteo API — free, no key needed.
 * Geocoding via Open-Meteo geocoding API.
 */
import { registerSkill } from "../loader.js";

const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Moderate showers",
  82: "Violent showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm + light hail",
  99: "Thunderstorm + heavy hail",
};

registerSkill({
  name: "weather.current",
  description:
    "Get current weather for a city. Default: Montreal. Shows temperature, wind, humidity, and conditions.",
  argsSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name (default: Montreal)",
      },
    },
  },
  async execute(args): Promise<string> {
    const city = (args.city as string) || "Montreal";

    // Geocode the city
    const geoResp = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`
    );
    const geoData = await geoResp.json();
    const loc = geoData?.results?.[0];
    if (!loc) return `City not found: "${city}"`;

    const { latitude, longitude, name, country } = loc;

    // Get current weather
    const wxResp = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,weather_code,precipitation` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code` +
        `&timezone=America/Toronto&forecast_days=3`
    );
    const wx = await wxResp.json();
    const c = wx?.current;
    if (!c) return "Weather data unavailable.";

    const condition = WMO_CODES[c.weather_code] || `Code ${c.weather_code}`;
    const lines = [
      `${name}, ${country} — ${condition}`,
      `Temp: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C)`,
      `Humidity: ${c.relative_humidity_2m}%`,
      `Wind: ${c.wind_speed_10m} km/h (gusts ${c.wind_gusts_10m} km/h)`,
      c.precipitation > 0 ? `Precipitation: ${c.precipitation} mm` : null,
    ].filter(Boolean);

    // 3-day forecast
    const daily = wx?.daily;
    if (daily?.time?.length) {
      lines.push("", "Forecast:");
      for (let i = 0; i < Math.min(daily.time.length, 3); i++) {
        const day = daily.time[i];
        const hi = daily.temperature_2m_max[i];
        const lo = daily.temperature_2m_min[i];
        const precip = daily.precipitation_sum[i];
        const code = WMO_CODES[daily.weather_code[i]] || "?";
        lines.push(
          `  ${day}: ${lo}°/${hi}°C — ${code}${precip > 0 ? ` (${precip}mm)` : ""}`
        );
      }
    }

    return lines.join("\n");
  },
});
