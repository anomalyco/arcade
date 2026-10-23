import { expect, test } from "bun:test"
import { SHELTER, sheltered } from "../src/weather/shelter"
import { lotWeatherDefaults } from "../src/weather/settings"

test("Today is the default and the deep link picks a mode", () => {
  expect(lotWeatherDefaults().weather).toBe("today")
  expect(lotWeatherDefaults(new URLSearchParams("weather=storm")).weather).toBe("storm")
  expect(lotWeatherDefaults(new URLSearchParams("weather=snow")).weather).toBe("today")
})

test("the booth roof and canopy shelter what is under them", () => {
  expect(sheltered(9, 127.5, SHELTER.booth)).toBe(true)
  expect(sheltered(0, 24, SHELTER.canopy)).toBe(true)
  expect(sheltered(0, 30, SHELTER.canopy)).toBe(false)
})
