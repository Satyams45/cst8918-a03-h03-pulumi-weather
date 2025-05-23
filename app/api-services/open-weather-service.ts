import { redis } from '../data-access/redis-connection'

const API_KEY = process.env.WEATHER_API_KEY
const BASE_URL = 'https://api.openweathermap.org/data/3.0/onecall'
const TEN_MINUTES = 1000 * 60 * 10 // in milliseconds

interface FetchWeatherDataParams {
  lat: number
  lon: number
  units: 'standard' | 'metric' | 'imperial'
}

export async function fetchWeatherData({
  lat,
  lon,
  units
}: FetchWeatherDataParams) {
  const queryString = `lat=${lat}&lon=${lon}&units=${units}`

  try {
    const cached = await redis.get(queryString)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (Array.isArray(parsed.weather)) {
        return parsed
      } else {
        console.warn("Cached data missing 'weather', ignoring.")
      }
    }
  } catch (err) {
    console.error("Error reading or parsing Redis cache:", err)
  }

  const response = await fetch(`${BASE_URL}?${queryString}&appid=${API_KEY}`)

  if (!response.ok) {
    const msg = await response.text()
    console.error("OpenWeather API error:", response.status, msg)
    throw new Error("Failed to fetch weather data.")
  }

  const text = await response.text()

  try {
    const parsed = JSON.parse(text)

    if (Array.isArray(parsed.weather)) {
      await redis.set(queryString, text, { PX: TEN_MINUTES })
    } else {
      console.warn("Fetched data missing 'weather', not caching.")
    }

    return parsed
  } catch (e) {
    console.error("Failed to parse weather API response:", e)
    throw e
  }
}
