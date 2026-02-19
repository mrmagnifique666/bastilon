// weather.current.js

async function weather_current(args) {
  const city = args.city || 'Gatineau';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=45.42&longitude=-75.70&current=temperature_2m,weather_code&timezone=auto`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    const temperature = data.current.temperature_2m;
    const weatherCode = data.current.weather_code;

    let weatherDescription = '';
    switch (weatherCode) {
      case 0: weatherDescription = 'Clear sky'; break;
      case 1: case 2: case 3: weatherDescription = 'Mainly clear'; break;
      case 45: case 48: weatherDescription = 'Fog'; break;
      case 51: case 56: case 61: weatherDescription = 'Drizzle'; break;
      case 66: case 71: weatherDescription = 'Rain'; break;
      case 80: case 81: case 82: weatherDescription = 'Showers'; break;
      case 95: case 96: case 99: weatherDescription = 'Thunderstorm'; break;
      default: weatherDescription = 'Unknown';
    }

    return `Météo actuelle à ${city}: ${temperature}°C, ${weatherDescription}`;

  } catch (error) {
    console.error("Erreur lors de la récupération de la météo:", error);
    return "Erreur lors de la récupération de la météo.";
  }
}

module.exports = weather_current;